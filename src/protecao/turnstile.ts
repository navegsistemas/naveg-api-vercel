/**
 * **O desafio, conferido na Cloudflare** — o adaptador de `VerificadorDoDesafio`.
 *
 * O token do Turnstile só vale depois de conferido no `siteverify`, com a chave **secreta**. Conferir no
 * navegador não significa nada: é o navegador que se quer pôr à prova.
 *
 * - **uma conferência por token**: a Cloudflare recusa o mesmo token duas vezes, então reenviar um pedido
 *   capturado não passa;
 * - **a ação tem de ser `reserva`**: é o nome que o widget do totem declara. Um token resolvido noutro widget
 *   do mesmo site não serve para reservar;
 * - **falha de rede lança** — vira `500`, e não um "desafio inválido" que culparia a pessoa pelo que é nosso.
 *
 * Para desenvolver, a Cloudflare publica chaves de teste que sempre passam (`1x0000000000000000000000000000000AA`
 * como secreta, `1x00000000000000000000AA` como pública).
 */
import type { VerificadorDoDesafio } from '../portas.js'

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** A ação que o widget do totem declara. */
export const ACAO_DO_DESAFIO = 'reserva'

export type Buscar = (url: string, init?: RequestInit) => Promise<Response>

export function desafioNaCloudflare(segredo: string, buscar: Buscar = (url, init) => fetch(url, init)): VerificadorDoDesafio {
  return {
    async verificar(token, ip) {
      const corpo = new URLSearchParams({ secret: segredo, response: token, remoteip: ip })
      const resposta = await buscar(SITEVERIFY, { method: 'POST', body: corpo })
      if (!resposta.ok) throw new Error(`siteverify respondeu HTTP ${resposta.status}`)

      const dado = (await resposta.json()) as { success?: unknown; action?: unknown }
      /* A ação só vem preenchida com chaves de verdade; as de teste respondem sem ela. */
      const acaoConfere = dado.action === undefined || dado.action === ACAO_DO_DESAFIO
      return dado.success === true && acaoConfere
    },
  }
}
