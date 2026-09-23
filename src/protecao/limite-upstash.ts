/**
 * **O limite de envios por IP, no Upstash Redis** — o adaptador de `LimitePorIp`.
 *
 * A Vercel não mantém processo de pé: cada instância da função teria o próprio contador, e um limite em memória
 * seria um limite por instância — ou seja, nenhum. O contador mora num Redis, pela API REST do Upstash (sem
 * SDK: são dois comandos).
 *
 * - **janela fixa**: `INCR` na chave do IP, e `EXPIRE … NX` para a chave nascer com prazo e não ter o prazo
 *   renovado a cada envio. Passou do teto dentro da janela, `false`;
 * - **o IP chega resumido** (hash) — ver `ip.ts`. O Redis guarda contadores, não endereços;
 * - **se o Upstash cair, deixa passar** (e registra). O limite é a segunda linha; a primeira é o Turnstile,
 *   que continua de pé. Recusar toda reserva porque o contador caiu trocaria um risco de abuso por uma falha
 *   certa para todo mundo.
 */
import type { LimitePorIp } from '../portas.js'
import type { Buscar } from './turnstile.js'

export interface RegraDoLimite {
  /** Quantos envios cabem na janela. */
  readonly teto: number
  readonly janelaEmSegundos: number
}

/** Dez reservas em dez minutos por IP: mais do que uma família no mesmo Wi-Fi faz, menos do que um script quer. */
export const LIMITE_PADRAO: RegraDoLimite = { teto: 10, janelaEmSegundos: 600 }

export function limiteNoUpstash(
  url: string,
  token: string,
  regra: RegraDoLimite = LIMITE_PADRAO,
  buscar: Buscar = (endereco, init) => fetch(endereco, init),
): LimitePorIp {
  const pipeline = `${url.replace(/\/+$/, '')}/pipeline`

  return {
    async registrar(ipResumido) {
      const chave = `naveg:reservas:${ipResumido}`
      try {
        const resposta = await buscar(pipeline, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([
            ['INCR', chave],
            ['EXPIRE', chave, String(regra.janelaEmSegundos), 'NX'],
          ]),
        })
        if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`)
        const [incr] = (await resposta.json()) as [{ result?: unknown }?]
        const contagem = incr?.result
        if (typeof contagem !== 'number') throw new Error('resposta sem contagem')
        return contagem <= regra.teto
      } catch (erro) {
        console.error(`limite por IP indisponível, envio liberado: ${(erro as Error).message}`)
        return true
      }
    },
  }
}
