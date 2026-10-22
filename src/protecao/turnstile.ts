/**
 * **O desafio, conferido na Cloudflare** — o adaptador de `VerificadorDoDesafio`.
 *
 * O token do Turnstile só vale depois de conferido no `siteverify`, com a chave **secreta**. Conferir no
 * navegador não significa nada: é o navegador que se quer pôr à prova.
 *
 * - **uma conferência por token**: a Cloudflare recusa o mesmo token duas vezes, então reenviar um pedido
 *   capturado não passa;
 * - **a ação tem de ser a do formulário**: `reserva` no totem, `cadastro` na criação da conta. Um token resolvido
 *   noutro widget do mesmo site não serve aqui — o do cadastro não reserva, e o da reserva não cria conta;
 * - **falha de rede lança** — vira `500`, e não um "desafio inválido" que culparia a pessoa pelo que é nosso.
 *
 * Para desenvolver, a Cloudflare publica chaves de teste que sempre passam (`1x0000000000000000000000000000000AA`
 * como secreta, `1x00000000000000000000AA` como pública).
 */
import type { VerificadorDoDesafio } from '../portas.js'

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** A ação que o widget do totem declara. */
export const ACAO_DO_DESAFIO = 'reserva'

/** A ação que o widget do cadastro declara (3.1). */
export const ACAO_DO_CADASTRO = 'cadastro'

/** A ação que o widget do entrar declara (3.3). */
export const ACAO_DO_ENTRAR = 'entrar'

export type Buscar = (url: string, init?: RequestInit) => Promise<Response>

export function desafioNaCloudflare(
  segredo: string,
  buscar: Buscar = (url, init) => fetch(url, init),
  acao: string = ACAO_DO_DESAFIO,
): VerificadorDoDesafio {
  return {
    async verificar(token, ip) {
      const corpo = new URLSearchParams({ secret: segredo, response: token, remoteip: ip })
      const resposta = await buscar(SITEVERIFY, { method: 'POST', body: corpo })
      if (!resposta.ok) throw new Error(`siteverify respondeu HTTP ${resposta.status}`)

      const dado = (await resposta.json()) as { success?: unknown; action?: unknown }
      /* A ação só vem preenchida com chaves de verdade; as de teste respondem sem ela. */
      const acaoConfere = dado.action === undefined || dado.action === acao
      return dado.success === true && acaoConfere
    },
  }
}
