/**
 * **O catálogo guardado por um minuto, dentro da instância** — para o `POST /reservas`.
 *
 * O `GET /catalogo` tem o cache da borda; o `POST` não pode usá-lo (a borda não guarda `POST`), e ler as cinco
 * coleções inteiras a cada reserva seria pagar o pool todo por pedido. Um minuto é o mesmo prazo do cache da
 * borda: o `POST` nunca vê um catálogo mais velho do que o totem pode ter visto.
 *
 * Falha **não** fica guardada: a próxima leitura tenta de novo.
 */
import type { CatalogoDoFluviapp } from '@navegsistemas/domain'

import type { LeitorDoCatalogo, Relogio } from './portas.js'

export const VALIDADE_DO_CACHE_MS = 60_000

export function leitorComCache(leitor: LeitorDoCatalogo, relogio: Relogio, validadeMs = VALIDADE_DO_CACHE_MS): LeitorDoCatalogo {
  let guardado: { readonly catalogo: CatalogoDoFluviapp; readonly lidoEm: number } | null = null

  return {
    async ler() {
      const agora = relogio().getTime()
      if (guardado !== null && agora - guardado.lidoEm < validadeMs) return guardado.catalogo
      const catalogo = await leitor.ler()
      guardado = { catalogo, lidoEm: agora }
      return catalogo
    },
  }
}
