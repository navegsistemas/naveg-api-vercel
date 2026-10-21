/**
 * **A senha, guardada como resumo scrypt** — a seção 2 da ADR-0003 (no `naveg-front`).
 *
 * A senha nunca é gravada: vai para `contasDeCliente/{id}/segredos/acesso` só o resumo, no formato
 * `scrypt$15$8$3$<sal>$<resumo>`, com o sal e o resumo em base64url.
 *
 * - **N = 2¹⁵, r = 8, p = 3**, uma das combinações que o OWASP recomenda. Conferir uma senha leva perto de 230 ms:
 *   imperceptível para quem entra, caro para quem tenta milhões;
 * - **os parâmetros vão junto do resumo.** Para subir o custo, muda-se o padrão: o resumo antigo continua
 *   conferindo com os parâmetros dele, e quem entra regrava com os novos (o PR de entrar);
 * - **a comparação é `timingSafeEqual`**: o tempo da resposta não diz quantos bytes acertaram.
 */
import { randomBytes, scrypt as scryptComRetorno, timingSafeEqual, type ScryptOptions } from 'node:crypto'

export interface ParametrosDoScrypt {
  /** O expoente do custo: N = 2^custo. */
  readonly custo: number
  readonly blocos: number
  readonly paralelismo: number
}

export const PARAMETROS_PADRAO: ParametrosDoScrypt = { custo: 15, blocos: 8, paralelismo: 3 }

const BYTES_DO_SAL = 16
const BYTES_DO_RESUMO = 64

function scrypt(senha: string, sal: Buffer, p: ParametrosDoScrypt): Promise<Buffer> {
  const N = 2 ** p.custo
  /* O teto de memória do Node (32 MiB) fica exatamente no que N = 2¹⁵ e r = 8 pedem, e ele recusa. O dobro basta. */
  const opcoes: ScryptOptions = { N, r: p.blocos, p: p.paralelismo, maxmem: 2 * 128 * N * p.blocos }
  return new Promise((resolver, rejeitar) => {
    scryptComRetorno(senha.normalize('NFKC'), sal, BYTES_DO_RESUMO, opcoes, (erro, chave) =>
      erro === null ? resolver(chave) : rejeitar(erro),
    )
  })
}

/** A senha → o resumo guardável, com um sal novo. */
export async function resumirSenha(senha: string, parametros: ParametrosDoScrypt = PARAMETROS_PADRAO): Promise<string> {
  const sal = randomBytes(BYTES_DO_SAL)
  const resumo = await scrypt(senha, sal, parametros)
  const { custo, blocos, paralelismo } = parametros
  return ['scrypt', custo, blocos, paralelismo, sal.toString('base64url'), resumo.toString('base64url')].join('$')
}

/** Lê o formato guardado, ou `null` quando ele não é o daqui. */
function lerResumo(guardado: string): { parametros: ParametrosDoScrypt; sal: Buffer; resumo: Buffer } | null {
  const partes = guardado.split('$')
  if (partes.length !== 6 || partes[0] !== 'scrypt') return null
  const [custo, blocos, paralelismo] = partes.slice(1, 4).map(Number)
  if (![custo, blocos, paralelismo].every((n) => Number.isInteger(n) && (n as number) > 0)) return null
  const sal = Buffer.from(partes[4] as string, 'base64url')
  const resumo = Buffer.from(partes[5] as string, 'base64url')
  if (sal.length === 0 || resumo.length === 0) return null
  return { parametros: { custo: custo as number, blocos: blocos as number, paralelismo: paralelismo as number }, sal, resumo }
}

/**
 * A senha confere com o resumo guardado? Um resumo ilegível é "não" — e registra, porque não deveria existir.
 */
export async function conferirSenha(senha: string, guardado: string): Promise<boolean> {
  const lido = lerResumo(guardado)
  if (lido === null) {
    console.error('resumo de senha num formato desconhecido')
    return false
  }
  const calculado = await scrypt(senha, lido.sal, lido.parametros)
  return calculado.length === lido.resumo.length && timingSafeEqual(calculado, lido.resumo)
}
