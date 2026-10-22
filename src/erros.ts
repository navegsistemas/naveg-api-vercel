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
  /** O envio de reservas não está configurado neste ambiente (falta o desafio ou o limite). */
  'ENVIO_INDISPONIVEL',
  /** O cadastro tem campo errado. Vem com `pendencias`, as do domínio (`PENDENCIAS_DO_CADASTRO`). */
  'CADASTRO_INVALIDO',
  /**
   * A senha é comum ou vazada. Vem com `pendencias`: `SENHA_COMUM` ou `SENHA_VAZADA` — a tela diz por quê (3.1, C). Na
   * senha nova (3.4), também `SENHA_CURTA`, a pendência do domínio.
   */
  'SENHA_FRACA',
  /** O cadastro de contas não está configurado neste ambiente. */
  'CADASTRO_INDISPONIVEL',
  /** O link de confirmação não confere: trocado por um mais novo, ou de conta que não existe (3.2, estado 4). */
  'LINK_INVALIDO',
  /** O link passou do prazo: 24 horas o de confirmação (3.2, B), 1 hora o de troca de senha (3.4, A). */
  'LINK_VENCIDO',
  /** A troca de senha não está configurada neste ambiente (falta o e-mail ou o segredo da sessão). */
  'SENHA_INDISPONIVEL',
  /** Entrar não está configurado neste ambiente (falta o segredo da sessão). */
  'ENTRAR_INDISPONIVEL',
  /** "E-mail ou senha não conferem" — a mesma resposta nos dois casos (3.3, B). */
  'CREDENCIAIS_INVALIDAS',
  /** 5 erros seguidos no mesmo e-mail: 15 minutos de espera (3.3, C). */
  'TENTATIVAS_DEMAIS',
  /** A senha certa de uma conta desativada pelo atendimento (3.3, F). */
  'CONTA_DESATIVADA',
  /** O pedido pede quem entrou, e o cookie falta, venceu ou não vale mais. */
  'SEM_SESSAO',
  /** Qualquer coisa nossa que deu errado. */
  'FALHA_INTERNA',
] as const

export type CodigoDeErro = (typeof CODIGOS)[number]

export interface CorpoDeErro {
  readonly erro: CodigoDeErro
  readonly mensagem: string
  /** As pendências, quando o erro é `RESERVA_INCOERENTE`, `CADASTRO_INVALIDO` ou `SENHA_FRACA`. O front tem texto para cada uma. */
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
