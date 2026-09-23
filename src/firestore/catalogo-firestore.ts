/**
 * **O catálogo lido do Firestore** — o adaptador de `LeitorDoCatalogo`.
 *
 * Lê as cinco coleções do catálogo e a concessão da NAVEG, e decodifica cada documento com o
 * `@navegsistemas/domain` — os mesmos `xDoDocumento` que leem como o aplicativo lê. Nenhuma regra mora aqui: o
 * adaptador busca e entrega; o recorte é da rota, e a regra é do domínio.
 *
 * ### O custo
 *
 * São cinco coleções inteiras por leitura — o pool de todas as empresas. Com o cache de borda de 60 s da rota,
 * isso é no máximo uma leitura completa por minuto, e o cadastro do fluviapp é pequeno. Se crescer, o primeiro
 * corte é filtrar `viagens` pelas embarcações da concessão (`in`, até 30 ids) — e fica registrado aqui, em
 * vez de feito antes de ser preciso.
 *
 * ### Por que uma interface mínima, e não o `Firestore`
 *
 * O adaptador depende só do que usa: `collection(nome).get()` e `doc(caminho).get()`. O `Firestore` do Admin
 * SDK satisfaz isso sem adaptação, e um cenário satisfaz com um objeto — sem emulador —, conferindo os caminhos
 * e a decodificação. O emulador continua sendo o teste de verdade, e é do passo 10.
 */
import {
  ATUACAO_DA_AGENCIA,
  atuacaoDoDocumento,
  COLECOES_DO_FLUVIAPP,
  embarcacaoDoDocumento,
  localidadeDoDocumento,
  portoDoDocumento,
  rotaDoDocumento,
  viagemDoDocumento,
} from '@navegsistemas/domain'

import type { LeitorDoCatalogo } from '../portas.js'

export interface DocumentoLido {
  readonly id: string
  data(): unknown
}

/** O pedaço do Firestore que este adaptador usa. */
export interface FirestoreDeLeitura {
  collection(nome: string): { get(): Promise<{ readonly docs: readonly DocumentoLido[] }> }
  doc(caminho: string): { get(): Promise<{ readonly exists: boolean; data(): unknown }> }
}

/** A coleção das empresas, no fluviapp. Não está em `COLECOES_DO_FLUVIAPP` porque o totem não a lê. */
const EMPRESAS = 'empresas'

function decodificar<T>(docs: readonly DocumentoLido[], decodificador: (id: string, dado: unknown) => T | null): T[] {
  return docs.flatMap((doc) => {
    const lido = decodificador(doc.id, doc.data())
    return lido === null ? [] : [lido]
  })
}

export function catalogoDoFirestore(db: FirestoreDeLeitura, empresaId: string): LeitorDoCatalogo {
  const caminhoDaConcessao = `${EMPRESAS}/${empresaId}/${COLECOES_DO_FLUVIAPP.atuacoes}/${ATUACAO_DA_AGENCIA}`

  return {
    async ler() {
      const [viagens, rotas, portos, localidades, embarcacoes, concessao] = await Promise.all([
        db.collection(COLECOES_DO_FLUVIAPP.viagens).get(),
        db.collection(COLECOES_DO_FLUVIAPP.rotas).get(),
        db.collection(COLECOES_DO_FLUVIAPP.portos).get(),
        db.collection(COLECOES_DO_FLUVIAPP.localidades).get(),
        db.collection(COLECOES_DO_FLUVIAPP.embarcacoes).get(),
        db.doc(caminhoDaConcessao).get(),
      ])

      return {
        viagens: decodificar(viagens.docs, viagemDoDocumento),
        rotas: decodificar(rotas.docs, rotaDoDocumento),
        portos: decodificar(portos.docs, portoDoDocumento),
        localidades: decodificar(localidades.docs, localidadeDoDocumento),
        embarcacoes: decodificar(embarcacoes.docs, embarcacaoDoDocumento),
        atuacao: concessao.exists ? atuacaoDoDocumento(concessao.data()) : null,
      }
    },
  }
}
