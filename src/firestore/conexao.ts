/**
 * **A conexão com o Firestore, uma por conta de serviço.**
 *
 * São duas contas (ver "As contas de serviço" no README), e cada uma vira um app do Admin SDK **com nome
 * próprio**. Um app só, trocando de credencial, faria a leitura e a escrita dividirem a mesma identidade — que
 * é exatamente o que as duas contas existem para impedir.
 *
 * A conexão é criada no escopo do módulo (`api/index.ts`), uma vez por instância da função: as invocações
 * seguintes reaproveitam.
 *
 * ### O que a mensagem de erro não diz
 *
 * O JSON da conta é segredo. Nenhum erro daqui cita o conteúdo dele — nem um pedaço, nem "o JSON recebido foi…".
 * Um log de erro de partida é lido por mais gente do que a variável de ambiente.
 */
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

export class ContaDeServicoInvalida extends Error {
  constructor(qual: string, motivo: string) {
    super(`A conta de serviço de ${qual} não serve: ${motivo}`)
    this.name = 'ContaDeServicoInvalida'
  }
}

interface ContaLida {
  readonly projectId: string
  readonly clientEmail: string
  readonly privateKey: string
}

/** Lê o JSON da conta, conferindo o que o Admin SDK precisa e que o projeto é o configurado. */
export function lerConta(qual: string, json: string, projetoEsperado: string): ContaLida {
  let dado: unknown
  try {
    dado = JSON.parse(json)
  } catch {
    throw new ContaDeServicoInvalida(qual, 'o valor não é JSON')
  }
  if (typeof dado !== 'object' || dado === null) throw new ContaDeServicoInvalida(qual, 'o JSON não é um objeto')

  const campo = (nome: string): string => {
    const valor = (dado as Record<string, unknown>)[nome]
    if (typeof valor !== 'string' || valor.trim().length === 0) {
      throw new ContaDeServicoInvalida(qual, `falta o campo "${nome}"`)
    }
    return valor
  }

  const conta = { projectId: campo('project_id'), clientEmail: campo('client_email'), privateKey: campo('private_key') }
  /* Chave de outro projeto autentica, e depois lê o banco errado — ou nenhum. Melhor parar na partida. */
  if (conta.projectId !== projetoEsperado) {
    throw new ContaDeServicoInvalida(qual, `é do projeto "${conta.projectId}", e o configurado é "${projetoEsperado}"`)
  }
  return conta
}

/** O app do Admin SDK de uma conta. Chamar de novo com o mesmo nome devolve o mesmo app. */
export function appDaConta(nome: 'leitura' | 'escrita', json: string, projeto: string): App {
  return (
    getApps().find((app) => app.name === nome) ??
    initializeApp({ credential: cert(lerConta(nome, json, projeto)), projectId: projeto }, nome)
  )
}

/**
 * O Firestore visto por uma conta — **só a de leitura**, desde que a escrita passou a ir pelo token de serviço
 * (`servico.ts`). A de escrita não abre Firestore pelo Admin SDK: ela só assina o token.
 */
export function firestoreDaConta(nome: 'leitura', json: string, projeto: string): Firestore {
  return getFirestore(appDaConta(nome, json, projeto))
}
