/**
 * **A configuração, lida uma vez e conferida na partida.**
 *
 * Toda variável que falta é um erro **agora**, e não na primeira requisição que precisar dela. A diferença
 * importa num servidor sem tela: sem isto, uma conta de serviço ausente vira `GET /catalogo` respondendo 500
 * às três da manhã, e o motivo só aparece no log de quem for procurar.
 *
 * Nada aqui tem prefixo público. Não existe caminho de uma destas variáveis até o bundle do front: quem fala
 * com o Firestore é este servidor, e o front só conhece a URL da API.
 */

export interface Config {
  readonly projetoFirebase: string
  /** JSON da conta de serviço que **lê** o catálogo. */
  readonly contaDeLeitura: string
  /** JSON da conta de serviço que **grava** reservas. Separada da de leitura — ver o README. */
  readonly contaDeEscrita: string
  readonly empresaId: string
  readonly origensPermitidas: readonly string[]
}

export class ConfiguracaoIncompleta extends Error {
  constructor(readonly faltando: readonly string[]) {
    super(`Faltam variáveis de ambiente: ${faltando.join(', ')}`)
    this.name = 'ConfiguracaoIncompleta'
  }
}

const OBRIGATORIAS = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CONTA_DE_LEITURA',
  'FIREBASE_CONTA_DE_ESCRITA',
  'NAVEG_EMPRESA_ID',
  'ORIGENS_PERMITIDAS',
] as const

/**
 * Lê o ambiente. **Não** lê `process.env` por conta própria em nenhum outro lugar do código: quem precisa de
 * configuração recebe a [Config], e é isso que deixa os cenários rodarem sem variável nenhuma.
 *
 * @throws [ConfiguracaoIncompleta] quando falta alguma — com a lista inteira, e não só a primeira.
 */
export function lerConfig(ambiente: Readonly<Record<string, string | undefined>> = process.env): Config {
  const faltando = OBRIGATORIAS.filter((chave) => (ambiente[chave] ?? '').trim().length === 0)
  if (faltando.length > 0) throw new ConfiguracaoIncompleta(faltando)

  return {
    projetoFirebase: (ambiente['FIREBASE_PROJECT_ID'] as string).trim(),
    contaDeLeitura: ambiente['FIREBASE_CONTA_DE_LEITURA'] as string,
    contaDeEscrita: ambiente['FIREBASE_CONTA_DE_ESCRITA'] as string,
    empresaId: (ambiente['NAVEG_EMPRESA_ID'] as string).trim(),
    origensPermitidas: (ambiente['ORIGENS_PERMITIDAS'] as string)
      .split(',')
      .map((origem) => origem.trim().replace(/\/$/, ''))
      .filter((origem) => origem.length > 0),
  }
}
