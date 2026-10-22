/**
 * **A senha comum ou vazada é recusada** (3.1, C; a seção 2 da ADR-0003), de dois jeitos:
 *
 * 1. **uma lista das senhas mais comuns**, aqui dentro, sem rede. Só as de 8 caracteres ou mais: as menores o
 *    domínio já recusa pelo tamanho. Entram as que aparecem no topo das listas públicas, mais as do português;
 * 2. **a base de senhas vazadas do Have I Been Pwned**, pela consulta por faixa (k-anonimato): vai só o começo do
 *    SHA-1 da senha, 5 caracteres, e a resposta traz todos os finais que começam assim. A senha, e mesmo o resumo
 *    inteiro dela, não saem da API. É gratuita e não tem chave.
 *
 * **Se a consulta não responder em 2 segundos, vale só a lista**, e o cadastro segue. Recusar toda conta porque um
 * serviço de fora caiu trocaria uma proteção a mais por uma falha certa para todo mundo — a mesma régua do limite.
 */
import { createHash } from 'node:crypto'

import type { ConsultaDeSenhaVazada } from '../portas.js'
import type { Buscar } from '../protecao/turnstile.js'

export type MotivoDaSenhaFraca = 'SENHA_COMUM' | 'SENHA_VAZADA'

const COMUNS: ReadonlySet<string> = new Set([
  '12345678', '123456789', '1234567890', '12345678910', '87654321', '11111111', '00000000', '88888888',
  '11223344', '12341234', '12121212', '123123123', '147258369', '123456123', '1q2w3e4r', '1q2w3e4r5t',
  'q1w2e3r4', 'qwertyui', 'qwerty123', 'qwertyuiop', 'asdfghjk', 'asdfasdf', 'zxcvbnm1', '1qaz2wsx',
  'password', 'password1', 'password123', 'passw0rd', 'iloveyou', 'sunshine', 'princess', 'football',
  'baseball', 'superman', 'whatever', 'trustno1', 'abcd1234', 'abc12345', 'abcdefgh', 'welcome1',
  'senha123', 'senha1234', 'senha12345', 'minhasenha', 'mudar123', 'mudarsenha', 'brasil123', 'flamengo',
  'corinthians', 'palmeiras', 'vasco123', 'gremio123', 'paysandu', 'remo1234', 'belem123', 'teamo123',
  'jesus123', 'deusefiel', 'deus1234', 'familia1', 'amor1234', 'naveg123', 'navegsistemas',
])

/** A senha está na lista das mais comuns? Sem diferença de maiúsculas e minúsculas. */
export function senhaComum(senha: string): boolean {
  return COMUNS.has(senha.trim().toLowerCase())
}

const PWNED = 'https://api.pwnedpasswords.com/range/'
export const TEMPO_DA_CONSULTA_MS = 2000

/** A consulta por faixa ao Have I Been Pwned. Falha ou demora: `false`, e o log diz. */
export function senhaVazadaNoHibp(
  buscar: Buscar = (url, init) => fetch(url, init),
  tempoMs: number = TEMPO_DA_CONSULTA_MS,
): ConsultaDeSenhaVazada {
  return {
    async vazada(senha) {
      const sha1 = createHash('sha1').update(senha, 'utf8').digest('hex').toUpperCase()
      const prefixo = sha1.slice(0, 5)
      const sufixo = sha1.slice(5)
      try {
        /* `Add-Padding` faz a resposta ter sempre o mesmo tamanho: quem olha a rede não deduz a faixa. */
        const resposta = await buscar(`${PWNED}${prefixo}`, {
          headers: { 'Add-Padding': 'true' },
          signal: AbortSignal.timeout(tempoMs),
        })
        if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`)
        const texto = await resposta.text()
        return texto.split('\n').some((linha) => {
          const [final, vezes] = linha.trim().split(':')
          return final === sufixo && Number(vezes) > 0
        })
      } catch (erro) {
        console.warn(`consulta de senha vazada indisponível, vale só a lista: ${(erro as Error).message}`)
        return false
      }
    },
  }
}

/** Por que a senha não serve, ou `null` quando serve. A lista primeiro: não gasta rede. */
export async function motivoDaSenhaFraca(senha: string, consulta: ConsultaDeSenhaVazada): Promise<MotivoDaSenhaFraca | null> {
  if (senhaComum(senha)) return 'SENHA_COMUM'
  if (await consulta.vazada(senha)) return 'SENHA_VAZADA'
  return null
}
