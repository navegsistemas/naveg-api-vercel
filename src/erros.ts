/**
 * **A forma de um erro** — uma só, para todas as rotas.
 *
 * O corpo é `{ erro, mensagem, pendencias? }`. O `erro` é um código estável, que o front usa para decidir; a
 * `mensagem` é para quem lê o log. **O front não mostra a mensagem daqui**: ele tem os textos dele, em
 * português de tela, e traduz o código. Uma API que devolve texto pronto para exibir acaba escrevendo a
 * interface de longe.
 *
 * O que **nunca** entra: mensagem do Firestore, caminho de arquivo, nome de coleção, id de documento alheio.
 * Erro de infraestrutura vaza estrutura, e estrutura é metade de um ataque.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export const CODIGOS = [
  /** O desafio do Turnstile faltou ou não valeu. */
  'DESAFIO_INVALIDO',
  /** Requisições demais deste IP. */
  'LIMITE_EXCEDIDO',
  /** A origem não é a da agência. */
  'ORIGEM_NAO_PERMITIDA',
  /** O corpo não tem a forma esperada. */
  'CORPO_INVALIDO',
  /** A travessia não está sendo ofertada agora — inativa, fora da concessão, ou já partiu. */
  'TRAVESSIA_INDISPONIVEL',
  /** As respostas não formam uma reserva. Vem com `pendencias`. */
  'RESERVA_INCOERENTE',
  /** Faltou responder alguma coisa; o roteiro do front sabe para onde levar. */
  'RESERVA_INCOMPLETA',
  /** Qualquer coisa nossa que deu errado. */
  'FALHA_INTERNA',
] as const

export type CodigoDeErro = (typeof CODIGOS)[number]

export interface CorpoDeErro {
  readonly erro: CodigoDeErro
  readonly mensagem: string
  /** As pendências do domínio, quando o erro é `RESERVA_INCOERENTE`. O front tem texto para cada uma. */
  readonly pendencias?: readonly string[]
}

export class ErroDaApi extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly codigo: CodigoDeErro,
    mensagem: string,
    readonly pendencias?: readonly string[],
  ) {
    super(mensagem)
    this.name = 'ErroDaApi'
  }

  corpo(): CorpoDeErro {
    return {
      erro: this.codigo,
      mensagem: this.message,
      ...(this.pendencias !== undefined ? { pendencias: [...this.pendencias] } : {}),
    }
  }
}
