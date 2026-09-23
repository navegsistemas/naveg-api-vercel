/**
 * **A reserva gravada no Firestore** — o adaptador de `ReservaRepositorio`, com a conta de **escrita**.
 *
 * É a única linha do código que usa a conta que pode escrever. Ela faz uma coisa: `create` em
 * `reservas/{codigo}`, com o documento que o codec do domínio produz (`paraDocumento`).
 *
 * - **`create`, nunca `set`.** O código é o id do documento, e `create` recusa um id que já existe
 *   (`ALREADY_EXISTS`). É isso que impede uma reserva sobrescrever outra — e é o caso `CODIGO_EM_USO`, que o
 *   `enviarReserva` resolve gerando outro código (ADR-0002, camada 4).
 * - **O Admin SDK passa por cima das Rules.** Por isso o que chega aqui já passou pelo domínio inteiro: montado
 *   por `montarReserva`, coerente por `pendenciasDaReserva`, serializado por `paraDocumento`.
 * - **O erro não sobe com texto.** A mensagem do Firestore vai para o log, só com o código gRPC; o resultado
 *   leva um motivo genérico. Nome e telefone nunca aparecem no log.
 */
import { paraDocumento, type Reserva, type ReservaRepositorio } from '@navegsistemas/domain'

/** A coleção, com o nome que as Rules do fluviapp e o aplicativo (passo 12) usam. */
export const COLECAO_DE_RESERVAS = 'reservas'

/** O pedaço do Firestore que este adaptador usa — o Admin SDK o cumpre sem adaptação. */
export interface FirestoreDeEscrita {
  doc(caminho: string): { create(dado: object): Promise<unknown> }
}

/** `ALREADY_EXISTS`, no gRPC. É o número que o Admin SDK põe em `code`. */
const JA_EXISTE = 6

export function reservaNoFirestore(db: FirestoreDeEscrita): ReservaRepositorio {
  return {
    async criar(reserva: Reserva) {
      try {
        await db.doc(`${COLECAO_DE_RESERVAS}/${reserva.codigo}`).create(paraDocumento(reserva))
        return { caso: 'GRAVADA' }
      } catch (erro) {
        const codigo = (erro as { code?: unknown } | null)?.code
        if (codigo === JA_EXISTE) return { caso: 'CODIGO_EM_USO' }
        console.error(`reserva ${reserva.codigo} não gravada: erro do Firestore de código ${String(codigo)}`)
        return { caso: 'FALHA', motivo: 'o banco recusou a gravação' }
      }
    },
  }
}
