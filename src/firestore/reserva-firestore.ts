/**
 * **A reserva gravada no Firestore** — o adaptador de `ReservaRepositorio`, **sob as Rules** do fluviapp.
 *
 * Grava pelo SDK cliente, autenticado como o usuário de serviço (`servico.ts`), e grava **dois documentos no
 * mesmo lote**: `reservas/{codigo}` e o evento `eventos/reserva.criada:{codigo}`. As Rules exigem os dois
 * juntos — a reserva não nasce sem ser narrada, e o evento não passa sem a reserva que ele narra (ADR-0013 do
 * `fluviapp-kmp`).
 *
 * - **O código livre é conferido na transação.** Pelo SDK cliente não há `create` que recuse id existente; a
 *   transação lê `reservas/{codigo}` e, se já existe, não grava nada — é o caso `CODIGO_EM_USO`, que o
 *   `enviarReserva` resolve gerando outro código (ADR-0002, camada 4). E se a leitura e a gravação correrem
 *   com outra gravação no meio, a transação refaz — nunca sobrescreve.
 * - **As Rules cercam, o domínio decide.** O documento vem montado por `montarReserva`, coerente por
 *   `pendenciasDaReserva` e serializado por `paraDocumento`; as Rules conferem dono, estado inicial e forma.
 * - **O erro não sobe com texto.** A mensagem do Firestore vai para o log, só com o código; o resultado leva um
 *   motivo genérico. Nome e telefone nunca aparecem no log.
 */
import { doc, runTransaction, type Firestore } from 'firebase/firestore'

import {
  eventoDaReservaCriada,
  idDoEvento,
  paraDocumento,
  type Reserva,
  type ReservaRepositorio,
} from '@navegsistemas/domain'

/** As coleções, com os nomes que as Rules do fluviapp e o aplicativo usam. */
export const COLECAO_DE_RESERVAS = 'reservas'
export const COLECAO_DE_EVENTOS = 'eventos'

export interface Escrita {
  readonly caminho: string
  readonly dado: object
}

/**
 * O pedaço do Firestore que este adaptador usa: gravar vários documentos **juntos, e só se o primeiro ainda
 * não existe**. Os cenários o cumprem em memória; [loteNoFirestore], com uma transação.
 */
export interface LoteDeCriacao {
  criarJuntos(escritas: readonly [Escrita, ...Escrita[]]): Promise<'CRIADOS' | 'JA_EXISTE'>
}

/** [porId] é o uid com que a API está autenticada — o do serviço. As Rules exigem que o evento o leve. */
export function reservaNoFirestore(lote: LoteDeCriacao, porId: string): ReservaRepositorio {
  return {
    async criar(reserva: Reserva) {
      const evento = eventoDaReservaCriada(reserva, porId)
      try {
        const resultado = await lote.criarJuntos([
          { caminho: `${COLECAO_DE_RESERVAS}/${reserva.codigo}`, dado: paraDocumento(reserva) },
          { caminho: `${COLECAO_DE_EVENTOS}/${idDoEvento(evento.tipo, reserva.codigo)}`, dado: evento },
        ])
        return resultado === 'CRIADOS' ? { caso: 'GRAVADA' } : { caso: 'CODIGO_EM_USO' }
      } catch (erro) {
        const codigo = (erro as { code?: unknown } | null)?.code
        console.error(`reserva ${reserva.codigo} não gravada: erro do Firestore de código ${String(codigo)}`)
        return { caso: 'FALHA', motivo: 'o banco recusou a gravação' }
      }
    },
  }
}

/** O lote de verdade: uma transação do SDK cliente, sobre o Firestore que [obter] entrega já autenticado. */
export function loteNoFirestore(obter: () => Promise<Firestore>): LoteDeCriacao {
  return {
    async criarJuntos(escritas) {
      const db = await obter()
      return runTransaction(db, async (transacao) => {
        const primeiro = await transacao.get(doc(db, escritas[0].caminho))
        if (primeiro.exists()) return 'JA_EXISTE'
        for (const { caminho, dado } of escritas) transacao.set(doc(db, caminho), dado)
        return 'CRIADOS'
      })
    },
  }
}
