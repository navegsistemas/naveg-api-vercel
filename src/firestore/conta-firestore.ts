/**
 * **As contas do site no Firestore** — o adaptador de `ContasDoCliente`, **sob as Rules** do fluviapp, como a
 * reserva (`reserva-firestore.ts`): o SDK cliente, autenticado como o serviço da agência.
 *
 * Tudo mora no cadastro da agência, `empresas/{agência}/`:
 *
 * - `contasDeCliente/{id}` — a conta, na forma do domínio (`loteDaContaNova`);
 * - `contasDeCliente/{id}/segredos/acesso` — o resumo da senha, a geração da sessão e os erros seguidos, que só o
 *   servidor lê (ADR-0003, seção 4);
 * - `resumos/contasDeCliente` — o que a plataforma vê, sem dado pessoal: mais uma no `total`, e a `ultimaCriadaEm`.
 *
 * **Os três vão num lote só**: a conta não existe sem a senha, e o resumo não conta conta que não existe. O resumo
 * soma com `increment`, que o Firestore aplica no servidor: dois cadastros ao mesmo tempo não se apagam.
 *
 * **Uma conta por e-mail.** A regra do KMP não tem índice de e-mail; quem garante é a API: a trava curta no Upstash
 * (a rota) e a procura aqui, antes de gravar.
 */
import {
  collection,
  doc,
  getDocs,
  increment,
  limit,
  query,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore'

import type { ContasDoCliente } from '../portas.js'

export const COLECAO_DE_CONTAS = 'contasDeCliente'
export const SEGREDO_DE_ACESSO = 'segredos/acesso'
export const RESUMO_DAS_CONTAS = 'resumos/contasDeCliente'

export function contasNoFirestore(obter: () => Promise<Firestore>, agenciaId: string): ContasDoCliente {
  const daAgencia = (caminho: string) => `empresas/${agenciaId}/${caminho}`

  return {
    async existeComEmail(email) {
      const db = await obter()
      const consulta = query(collection(db, daAgencia(COLECAO_DE_CONTAS)), where('email', '==', email), limit(1))
      return !(await getDocs(consulta)).empty
    },

    async criar(contaId, lote, acesso, criadaEm) {
      try {
        const db = await obter()
        const escritas = writeBatch(db)
        for (const escrita of lote) {
          if (escrita.op === 'apagar') escritas.delete(doc(db, daAgencia(escrita.caminho)))
          else escritas.set(doc(db, daAgencia(escrita.caminho)), escrita.dados, { merge: escrita.op === 'atualizar' })
        }
        escritas.set(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_ACESSO}`)), { ...acesso })
        escritas.set(
          doc(db, daAgencia(RESUMO_DAS_CONTAS)),
          /* `confirmadas` soma zero: no primeiro cadastro o resumo nasce, e a regra pede as duas contagens. */
          { total: increment(1), confirmadas: increment(0), ultimaCriadaEm: criadaEm },
          { merge: true },
        )
        await escritas.commit()
        return true
      } catch (erro) {
        const codigo = (erro as { code?: unknown } | null)?.code
        console.error(`conta ${contaId} não gravada: erro do Firestore de código ${String(codigo)}`)
        return false
      }
    },
  }
}
