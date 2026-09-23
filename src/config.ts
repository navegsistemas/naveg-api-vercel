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
  /**
   * O que protege o `POST /reservas`: a chave secreta do Turnstile e o Upstash do limite por IP. **Opcional**,
   * e junto: faltando qualquer peça, o envio responde `503` e o catálogo segue servindo. Um `POST` sem desafio
   * ou sem limite não existe — nem em desenvolvimento.
   */
  readonly protecaoDoEnvio: ProtecaoDoEnvio | null
}

export interface ProtecaoDoEnvio {
  readonly segredoDoTurnstile: string
  readonly upstashUrl: string
  readonly upstashToken: string
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
    protecaoDoEnvio: lerProtecao(ambiente),
  }
}

const PROTECAO = ['TURNSTILE_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const

/** As três juntas, ou nenhuma. Metade configurada é o mesmo que nada — e a partida diz o que falta. */
function lerProtecao(ambiente: Readonly<Record<string, string | undefined>>): ProtecaoDoEnvio | null {
  const presentes = PROTECAO.filter((chave) => (ambiente[chave] ?? '').trim().length > 0)
  if (presentes.length < PROTECAO.length) {
    const faltando = PROTECAO.filter((chave) => !presentes.includes(chave))
    console.warn(`envio de reservas desligado: faltam ${faltando.join(', ')}`)
    return null
  }
  return {
    segredoDoTurnstile: (ambiente['TURNSTILE_SECRET'] as string).trim(),
    upstashUrl: (ambiente['UPSTASH_REDIS_REST_URL'] as string).trim(),
    upstashToken: (ambiente['UPSTASH_REDIS_REST_TOKEN'] as string).trim(),
  }
}
