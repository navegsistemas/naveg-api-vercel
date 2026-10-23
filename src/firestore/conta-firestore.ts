/**
 * **As contas do site no Firestore** — o adaptador de `ContasDoCliente`, **sob as Rules** do fluviapp, como a
 * reserva (`reserva-firestore.ts`): o SDK cliente, autenticado como o serviço da agência.
 *
 * Tudo mora no cadastro da agência, `empresas/{agência}/`:
 *
 * - `contasDeCliente/{id}` — a conta, na forma do domínio (`loteDaContaNova`);
 * - `contasDeCliente/{id}/segredos/acesso` — o resumo da senha, a geração da sessão e os erros seguidos, que só o
 *   servidor lê (ADR-0003, seção 4);
 * - `contasDeCliente/{id}/segredos/confirmacao` — o resumo do código do link de confirmação e o prazo (seção 3);
 * - `contasDeCliente/{id}/segredos/trocaDeSenha` — o mesmo, do link de troca de senha (3.4), apagado ao ser usado;
 * - `contasDeCliente/{id}/segredos/trocaDeEmail` — o mesmo, do link da troca de e-mail (4.2, B), com o e-mail novo,
 *   que só vai para a conta quando o link é aberto;
 * - `resumos/contasDeCliente` — o que a plataforma vê, sem dado pessoal: mais uma no `total`, e a `ultimaCriadaEm`;
 *   ao confirmar, mais uma nas `confirmadas`.
 *
 * **O cadastro vai num lote só**: a conta não existe sem a senha e o link, e o resumo não conta conta que não existe.
 * A confirmação também: a conta confirmada, o link apagado e o resumo. O resumo soma com `increment`, que o
 * Firestore aplica no servidor: dois cadastros ao mesmo tempo não se apagam.
 *
 * **Uma conta por e-mail.** A regra do KMP não tem índice de e-mail; quem garante é a API: a trava curta no Upstash
 * (a rota) e a procura aqui, antes de gravar.
 */
import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore'

import { contaDoDocumento, loteDaContaApagada } from '@navegsistemas/domain'

import type {
  ContasDoCliente,
  DadosDaConta,
  SegredoDeAcesso,
  SegredoDeConfirmacao,
  SegredoDeTrocaDeEmail,
} from '../portas.js'

export const COLECAO_DE_CONTAS = 'contasDeCliente'
export const SEGREDO_DE_ACESSO = 'segredos/acesso'
export const SEGREDO_DE_CONFIRMACAO = 'segredos/confirmacao'
export const SEGREDO_DE_TROCA = 'segredos/trocaDeSenha'
export const SEGREDO_DE_TROCA_DE_EMAIL = 'segredos/trocaDeEmail'
export const RESUMO_DAS_CONTAS = 'resumos/contasDeCliente'

/** Todos os segredos que a conta pode ter: apagar a conta leva todos. */
export const SEGREDOS_DA_CONTA = [
  SEGREDO_DE_ACESSO,
  SEGREDO_DE_CONFIRMACAO,
  SEGREDO_DE_TROCA,
  SEGREDO_DE_TROCA_DE_EMAIL,
] as const

export function contasNoFirestore(obter: () => Promise<Firestore>, agenciaId: string): ContasDoCliente & DadosDaConta {
  const daAgencia = (caminho: string) => `empresas/${agenciaId}/${caminho}`

  return {
    async existeComEmail(email) {
      const db = await obter()
      const consulta = query(collection(db, daAgencia(COLECAO_DE_CONTAS)), where('email', '==', email), limit(1))
      return !(await getDocs(consulta)).empty
    },

    async criar(contaId, lote, acesso, confirmacao, criadaEm) {
      try {
        const db = await obter()
        const escritas = writeBatch(db)
        for (const escrita of lote) {
          if (escrita.op === 'apagar') escritas.delete(doc(db, daAgencia(escrita.caminho)))
          else escritas.set(doc(db, daAgencia(escrita.caminho)), escrita.dados, { merge: escrita.op === 'atualizar' })
        }
        escritas.set(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_ACESSO}`)), { ...acesso })
        escritas.set(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_CONFIRMACAO}`)), { ...confirmacao })
        escritas.set(
          doc(db, daAgencia(RESUMO_DAS_CONTAS)),
          /* `confirmadas` soma zero: no primeiro cadastro o resumo nasce, e a regra pede as duas contagens. */
          { total: increment(1), confirmadas: increment(0), ultimaCriadaEm: criadaEm },
          { merge: true },
        )
        await escritas.commit()
        return true
      } catch (erro) {
        console.error(`conta ${contaId} não gravada: erro do Firestore de código ${codigoDoErro(erro)}`)
        return false
      }
    },

    async registrarEnvio(contaId, tipo, em) {
      try {
        const db = await obter()
        await updateDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}`)), {
          ultimoEnvioTipo: tipo,
          ultimoEnvioEm: em,
        })
      } catch (erro) {
        /* O espelho é para o painel; a falta dele não desfaz o envio. */
        console.error(`conta ${contaId}: último envio não registrado, erro de código ${codigoDoErro(erro)}`)
      }
    },

    async paraConfirmar(contaId) {
      const db = await obter()
      const [conta, segredo, acesso] = await Promise.all([
        getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}`))),
        getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_CONFIRMACAO}`))),
        getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_ACESSO}`))),
      ])
      if (!conta.exists()) return null
      const lida = contaDoDocumento(contaId, conta.data())
      const segredos = segredoDeAcesso(acesso.data())
      if (lida === null || segredos === null) {
        console.error(`conta ${contaId} sem a forma da regra: confirmação recusada`)
        return null
      }
      return {
        confirmadaEm: lida.confirmadaEm,
        confirmacao: segredoDeConfirmacao(segredo.data()),
        ativa: lida.ativa,
        geracao: segredos.geracao,
      }
    },

    async confirmar(contaId, em) {
      try {
        const db = await obter()
        const escritas = writeBatch(db)
        escritas.update(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}`)), { confirmadaEm: em })
        escritas.delete(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_CONFIRMACAO}`)))
        escritas.set(
          doc(db, daAgencia(RESUMO_DAS_CONTAS)),
          { total: increment(0), confirmadas: increment(1) },
          { merge: true },
        )
        await escritas.commit()
        return true
      } catch (erro) {
        console.error(`conta ${contaId} não confirmada: erro do Firestore de código ${codigoDoErro(erro)}`)
        return false
      }
    },

    async paraMandarLink(email) {
      const db = await obter()
      const consulta = query(collection(db, daAgencia(COLECAO_DE_CONTAS)), where('email', '==', email), limit(1))
      const conta = (await getDocs(consulta)).docs[0]
      if (conta === undefined) return null
      const lida = contaDoDocumento(conta.id, conta.data())
      if (lida === null) {
        console.error(`conta ${conta.id} sem a forma da regra: reenvio recusado`)
        return null
      }
      return { contaId: conta.id, nome: lida.nome, confirmada: lida.confirmadaEm !== null, ativa: lida.ativa }
    },

    async trocarConfirmacao(contaId, confirmacao) {
      try {
        const db = await obter()
        /* Por cima do anterior: o resumo do código velho some, e o link dele deixa de conferir. */
        await setDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_CONFIRMACAO}`)), { ...confirmacao })
        return true
      } catch (erro) {
        console.error(`conta ${contaId}: link novo não gravado, erro do Firestore de código ${codigoDoErro(erro)}`)
        return false
      }
    },

    async gravarTrocaDeSenha(contaId, troca) {
      try {
        const db = await obter()
        await setDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_TROCA}`)), { ...troca })
        return true
      } catch (erro) {
        console.error(`conta ${contaId}: link de troca não gravado, erro do Firestore de código ${codigoDoErro(erro)}`)
        return false
      }
    },

    async paraTrocarSenha(contaId) {
      const db = await obter()
      const [conta, troca, acesso] = await Promise.all([
        getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}`))),
        getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_TROCA}`))),
        getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_ACESSO}`))),
      ])
      if (!conta.exists()) return null
      const lida = contaDoDocumento(contaId, conta.data())
      const segredos = segredoDeAcesso(acesso.data())
      if (lida === null || segredos === null) {
        console.error(`conta ${contaId} sem a forma da regra: troca de senha recusada`)
        return null
      }
      return {
        troca: segredoDeConfirmacao(troca.data()),
        ativa: lida.ativa,
        confirmadaEm: lida.confirmadaEm,
        bloqueadaAte: lida.bloqueadaAte,
        geracao: segredos.geracao,
        nome: lida.nome,
        email: lida.email,
      }
    },

    async trocarSenha(contaId, troca) {
      try {
        const db = await obter()
        const escritas = writeBatch(db)
        const daConta = (caminho: string) => doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}${caminho}`))
        escritas.update(daConta(`/${SEGREDO_DE_ACESSO}`), {
          resumoDaSenha: troca.resumoDaSenha,
          geracao: troca.geracao,
          errosSeguidos: 0,
        })
        /* Vale uma vez só (3.4, A). */
        escritas.delete(daConta(`/${SEGREDO_DE_TROCA}`))
        const naConta: Record<string, unknown> = {}
        if (troca.confirmarEm !== null) naConta['confirmadaEm'] = troca.confirmarEm
        /* Ausente, e não `null`, como em `registrarEntrada`. */
        if (troca.tirarBloqueio) naConta['bloqueadaAte'] = deleteField()
        if (Object.keys(naConta).length > 0) escritas.update(daConta(''), naConta)
        if (troca.confirmarEm !== null) {
          /* Confirmada pelo link de troca (3.4, E): o link de confirmação sai, e o resumo conta mais uma. */
          escritas.delete(daConta(`/${SEGREDO_DE_CONFIRMACAO}`))
          escritas.set(
            doc(db, daAgencia(RESUMO_DAS_CONTAS)),
            { total: increment(0), confirmadas: increment(1) },
            { merge: true },
          )
        }
        await escritas.commit()
        return true
      } catch (erro) {
        console.error(`conta ${contaId}: senha não trocada, erro do Firestore de código ${codigoDoErro(erro)}`)
        return false
      }
    },

    async paraEntrar(email) {
      const db = await obter()
      const consulta = query(collection(db, daAgencia(COLECAO_DE_CONTAS)), where('email', '==', email), limit(1))
      const achadas = await getDocs(consulta)
      const conta = achadas.docs[0]
      if (conta === undefined) return null
      const lida = contaDoDocumento(conta.id, conta.data())
      const acesso = segredoDeAcesso(
        (await getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${conta.id}/${SEGREDO_DE_ACESSO}`)))).data(),
      )
      if (lida === null || acesso === null) {
        console.error(`conta ${conta.id} sem a forma da regra: entrada recusada`)
        return null
      }
      return {
        contaId: conta.id,
        ativa: lida.ativa,
        confirmada: lida.confirmadaEm !== null,
        bloqueadaAte: lida.bloqueadaAte,
        acesso,
      }
    },

    async registrarErroDeSenha(contaId, errosSeguidos, bloqueadaAte) {
      try {
        const db = await obter()
        const escritas = writeBatch(db)
        escritas.update(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_ACESSO}`)), { errosSeguidos })
        if (bloqueadaAte !== null) {
          escritas.update(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}`)), { bloqueadaAte })
        }
        await escritas.commit()
        return true
      } catch (erro) {
        console.error(`conta ${contaId}: erro de senha não registrado, código ${codigoDoErro(erro)}`)
        return false
      }
    },

    async registrarEntrada(contaId, tinhaBloqueio) {
      try {
        const db = await obter()
        const escritas = writeBatch(db)
        escritas.update(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_ACESSO}`)), { errosSeguidos: 0 })
        if (tinhaBloqueio) {
          /* Ausente, e não `null`: o decodificador do KMP prefere a chave que não está (`conta-do-cliente.ts`). */
          escritas.update(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}`)), { bloqueadaAte: deleteField() })
        }
        await escritas.commit()
        return true
      } catch (erro) {
        console.error(`conta ${contaId}: entrada não registrada, código ${codigoDoErro(erro)}`)
        return false
      }
    },

    async paraSessao(contaId) {
      const db = await obter()
      const [conta, acesso] = await Promise.all([
        getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}`))),
        getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_ACESSO}`))),
      ])
      if (!conta.exists()) return null
      const lida = contaDoDocumento(contaId, conta.data())
      const segredos = segredoDeAcesso(acesso.data())
      if (lida === null || segredos === null) return null
      return { ativa: lida.ativa, confirmada: lida.confirmadaEm !== null, geracao: segredos.geracao }
    },

    async paraMeusDados(contaId) {
      const db = await obter()
      const [conta, acesso] = await Promise.all([
        getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}`))),
        getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_ACESSO}`))),
      ])
      if (!conta.exists()) return null
      const lida = contaDoDocumento(contaId, conta.data())
      const segredos = segredoDeAcesso(acesso.data())
      if (lida === null || segredos === null) {
        console.error(`conta ${contaId} sem a forma da regra: Meus dados recusado`)
        return null
      }
      return { conta: lida, acesso: segredos }
    },

    async salvarDados(contaId, dados) {
      try {
        const db = await obter()
        await updateDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}`)), {
          nome: dados.nome,
          telefone: dados.telefone,
        })
        return true
      } catch (erro) {
        console.error(`conta ${contaId}: dados não salvos, erro do Firestore de código ${codigoDoErro(erro)}`)
        return false
      }
    },

    async gravarTrocaDeEmail(contaId, troca) {
      try {
        const db = await obter()
        /* Por cima do anterior: o link do pedido velho deixa de conferir. */
        await setDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_TROCA_DE_EMAIL}`)), { ...troca })
        return true
      } catch (erro) {
        console.error(`conta ${contaId}: troca de e-mail não gravada, erro do Firestore de código ${codigoDoErro(erro)}`)
        return false
      }
    },

    async paraTrocarEmail(contaId) {
      const db = await obter()
      const [conta, troca] = await Promise.all([
        getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}`))),
        getDoc(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}/${SEGREDO_DE_TROCA_DE_EMAIL}`))),
      ])
      if (!conta.exists()) return null
      const lida = contaDoDocumento(contaId, conta.data())
      if (lida === null) {
        console.error(`conta ${contaId} sem a forma da regra: troca de e-mail recusada`)
        return null
      }
      return { troca: segredoDeTrocaDeEmail(troca.data()), ativa: lida.ativa, confirmadaEm: lida.confirmadaEm }
    },

    async trocarEmail(contaId, novoEmail, confirmarEm) {
      try {
        const db = await obter()
        const escritas = writeBatch(db)
        const daConta = (caminho: string) => doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${contaId}${caminho}`))
        escritas.update(daConta(''), confirmarEm === null ? { email: novoEmail } : { email: novoEmail, confirmadaEm: confirmarEm })
        /* Vale uma vez só. */
        escritas.delete(daConta(`/${SEGREDO_DE_TROCA_DE_EMAIL}`))
        if (confirmarEm !== null) {
          /* Confirmada pelo link do e-mail novo: o link de confirmação do antigo sai, e o resumo conta mais uma. */
          escritas.delete(daConta(`/${SEGREDO_DE_CONFIRMACAO}`))
          escritas.set(
            doc(db, daAgencia(RESUMO_DAS_CONTAS)),
            { total: increment(0), confirmadas: increment(1) },
            { merge: true },
          )
        }
        await escritas.commit()
        return true
      } catch (erro) {
        console.error(`conta ${contaId}: e-mail não trocado, erro do Firestore de código ${codigoDoErro(erro)}`)
        return false
      }
    },

    async apagarConta(conta) {
      try {
        const db = await obter()
        const escritas = writeBatch(db)
        /* A conta e o índice, do domínio: o documento fica livre no mesmo lote (a regra confere um pelo outro). */
        for (const escrita of loteDaContaApagada(conta)) escritas.delete(doc(db, daAgencia(escrita.caminho)))
        /* Os segredos todos: sem eles, nenhum cookie e nenhum link da conta vale mais. */
        for (const segredo of SEGREDOS_DA_CONTA) {
          escritas.delete(doc(db, daAgencia(`${COLECAO_DE_CONTAS}/${conta.id}/${segredo}`)))
        }
        escritas.set(
          doc(db, daAgencia(RESUMO_DAS_CONTAS)),
          { total: increment(-1), confirmadas: increment(conta.confirmadaEm === null ? 0 : -1) },
          { merge: true },
        )
        await escritas.commit()
        return true
      } catch (erro) {
        console.error(`conta ${conta.id} não apagada: erro do Firestore de código ${codigoDoErro(erro)}`)
        return false
      }
    },
  }
}

/** O pedido de troca de e-mail lido → a forma da porta, ou `null` quando não há (ou não tem a forma esperada). */
function segredoDeTrocaDeEmail(dado: unknown): SegredoDeTrocaDeEmail | null {
  const link = segredoDeConfirmacao(dado)
  const { novoEmail } = (dado ?? {}) as Record<string, unknown>
  return link === null || typeof novoEmail !== 'string' ? null : { ...link, novoEmail }
}

/** Os segredos de acesso lidos → a forma da porta, ou `null` quando faltam (ou não têm a forma esperada). */
function segredoDeAcesso(dado: unknown): SegredoDeAcesso | null {
  if (typeof dado !== 'object' || dado === null) return null
  const { resumoDaSenha, geracao, errosSeguidos } = dado as Record<string, unknown>
  if (typeof resumoDaSenha !== 'string' || typeof geracao !== 'number' || typeof errosSeguidos !== 'number') return null
  return { resumoDaSenha, geracao, errosSeguidos }
}

function codigoDoErro(erro: unknown): string {
  return String((erro as { code?: unknown } | null)?.code)
}

/** O segredo lido → a forma da porta, ou `null` quando não há (ou não tem a forma esperada). */
function segredoDeConfirmacao(dado: unknown): SegredoDeConfirmacao | null {
  if (typeof dado !== 'object' || dado === null) return null
  const { resumoDoCodigo, valeAte } = dado as Record<string, unknown>
  if (typeof resumoDoCodigo !== 'string' || typeof valeAte !== 'number') return null
  return { resumoDoCodigo, valeAte }
}
