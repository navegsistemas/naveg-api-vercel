/**
 * **A API como usuário de serviço** — como ela grava sob as Firestore Rules do fluviapp (ADR-0013 de lá, a P3
 * do ADR-0010).
 *
 * Até aqui a escrita usava o Admin SDK, que passa por cima das Rules: o código desta API era a última linha de
 * defesa da coleção `reservas`. Agora a conta de escrita só **assina um token customizado** para o uid
 * [UID_DO_SERVICO], com duas *claims* — `papel: 'SERVICO'` e a agência —, e a gravação vai pelo **SDK cliente**,
 * autenticado com esse token. As Rules reconhecem o serviço por essas *claims*, e passam a cercar o que ele
 * grava: nasce `RESERVADA`, do totem, da agência **do token**, com o evento no mesmo lote. Nenhum engano daqui
 * cria reserva já tratada, de outra agência, ou por cima de outra.
 *
 * ### A conta de escrita deixa de precisar de papel no Firestore
 *
 * Assinar o token é usar a chave privada dela — não pede IAM. Depois que esta versão estiver no ar, o papel
 * *Cloud Datastore User* dessa conta deve ser **removido**: é isso que tira de uma chave vazada o poder de
 * gravar por cima das Rules. Ver o README.
 *
 * ### Uma sessão por instância, e refeita se falhar
 *
 * O login acontece na primeira gravação, não na partida — o catálogo não precisa dele, e uma falha aqui não
 * deve derrubar o `GET`. O SDK cliente renova o token de acesso sozinho. Se o login falhar, a próxima gravação
 * tenta de novo, em vez de herdar a falha para sempre.
 */
import { getApps as appsDoCliente, initializeApp as iniciarCliente } from 'firebase/app'
import { getAuth as authDoCliente, signInWithCustomToken } from 'firebase/auth'
import { getFirestore as firestoreDoCliente, type Firestore } from 'firebase/firestore'
import { getAuth as authDoAdmin } from 'firebase-admin/auth'

import { appDaConta } from './conexao.js'

/** O uid do serviço. Não tem `users/{uid}` no fluviapp — o serviço não é pessoa, e as Rules não o tratam como uma. */
export const UID_DO_SERVICO = 'naveg-api'

/** As *claims* que as Rules conferem em `ehServico()`. */
export interface ClaimsDoServico {
  readonly papel: 'SERVICO'
  readonly agenciaId: string
}

export function claimsDoServico(agenciaId: string): ClaimsDoServico {
  return { papel: 'SERVICO', agenciaId }
}

/** O que a sessão precisa do mundo — os dois SDKs, separados para que o cenário não precise de nenhum. */
export interface PassosDaSessao {
  emitirToken(uid: string, claims: ClaimsDoServico): Promise<string>
  entrar(token: string): Promise<Firestore>
}

/**
 * O Firestore **autenticado como o serviço**, sob demanda: a primeira chamada emite o token e entra; as
 * seguintes reaproveitam a mesma sessão. Uma falha não fica guardada — a chamada seguinte tenta de novo.
 */
export function sessaoDoServico(agenciaId: string, passos: PassosDaSessao): () => Promise<Firestore> {
  let sessao: Promise<Firestore> | null = null
  return () => {
    sessao ??= passos
      .emitirToken(UID_DO_SERVICO, claimsDoServico(agenciaId))
      .then((token) => passos.entrar(token))
      .catch((erro: unknown) => {
        sessao = null
        throw erro
      })
    return sessao
  }
}

export interface OpcoesDoServico {
  /** JSON da conta de escrita — só assina o token. */
  readonly contaDeEscrita: string
  readonly projeto: string
  /** A chave Web do projeto (`apiKey` do app Web do Firebase). Não é segredo, mas é por ambiente. */
  readonly chaveWeb: string
  readonly agenciaId: string
}

/** A sessão com os SDKs de verdade: o Admin assina, o cliente entra. */
export function sessaoDoServicoNoFirebase(opcoes: OpcoesDoServico): () => Promise<Firestore> {
  return sessaoDoServico(opcoes.agenciaId, {
    emitirToken: (uid, claims) =>
      authDoAdmin(appDaConta('escrita', opcoes.contaDeEscrita, opcoes.projeto)).createCustomToken(uid, { ...claims }),
    entrar: async (token) => {
      const app =
        appsDoCliente().find((existente) => existente.name === 'servico') ??
        iniciarCliente({ apiKey: opcoes.chaveWeb, projectId: opcoes.projeto }, 'servico')
      await signInWithCustomToken(authDoCliente(app), token)
      return firestoreDoCliente(app)
    },
  })
}
