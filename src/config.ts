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
  /**
   * JSON da conta de serviço que **assina o token** com que a API grava reservas sob as Rules do fluviapp.
   * Separada da de leitura — ver o README.
   */
  readonly contaDeEscrita: string
  /**
   * A chave Web do projeto (`apiKey` do app Web do Firebase) — o SDK cliente precisa dela para entrar com o
   * token de serviço. **Opcional**: sem ela, o envio responde `503`, como sem a proteção, e o catálogo segue.
   */
  readonly chaveWebDoFirebase: string | null
  readonly empresaId: string
  readonly origensPermitidas: readonly string[]
  /**
   * O que protege o `POST /reservas`: a chave secreta do Turnstile e o Upstash do limite por IP. **Opcional**,
   * e junto: faltando qualquer peça, o envio responde `503` e o catálogo segue servindo. Um `POST` sem desafio
   * ou sem limite não existe — nem em desenvolvimento.
   */
  readonly protecaoDoEnvio: ProtecaoDoEnvio | null
  /**
   * A conta do Google Workspace que manda os e-mails da conta do cliente. **Opcional**: sem ela, o cadastro responde
   * `503`, porque uma conta que não recebe o link nunca se confirma.
   */
  readonly envioDeEmail?: ContaDeEnvio | null
  /**
   * O segredo que assina o cookie da sessão (ADR-0003, seção 1), e o anterior, durante uma troca. **Opcional**: sem
   * ele, entrar responde `503`, e quem confirma o e-mail não fica dentro da conta.
   */
  readonly segredosDaSessao?: SegredosDaSessao | null
}

export interface SegredosDaSessao {
  readonly atual: string
  /** O segredo de antes de uma troca, que ainda confere enquanto os cookies antigos vencem. */
  readonly anterior: string | null
}

export interface ProtecaoDoEnvio {
  readonly segredoDoTurnstile: string
  readonly upstashUrl: string
  readonly upstashToken: string
}

/** A conta que entra no SMTP do Gmail (`email/smtp.ts`). */
export interface ContaDeEnvio {
  /** O login da conta Workspace no SMTP. */
  readonly usuario: string
  /** A senha de app dessa conta (16 letras), e não a senha dela. */
  readonly senhaDeApp: string
  /** O endereço que aparece como remetente: o apelido `naoresponda@`. */
  readonly remetente: string
  /** Para onde vão as respostas. */
  readonly responderPara: string
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
    chaveWebDoFirebase: lerChaveWeb(ambiente),
    envioDeEmail: lerEnvioDeEmail(ambiente),
    segredosDaSessao: lerSegredosDaSessao(ambiente),
  }
}

/** Um segredo de sessão curto se adivinha: 32 bytes em base64url são 43 caracteres. */
export const SEGREDO_MAIS_CURTO = 32

/** O segredo atual, e o anterior se houver. Curto demais é o mesmo que nenhum — e a partida diz. */
function lerSegredosDaSessao(ambiente: Readonly<Record<string, string | undefined>>): SegredosDaSessao | null {
  const atual = (ambiente['SEGREDO_DA_SESSAO'] ?? '').trim()
  if (atual.length < SEGREDO_MAIS_CURTO) {
    console.warn(
      atual.length === 0
        ? 'entrar na conta desligado: falta SEGREDO_DA_SESSAO'
        : `entrar na conta desligado: SEGREDO_DA_SESSAO com menos de ${SEGREDO_MAIS_CURTO} caracteres`,
    )
    return null
  }
  const anterior = (ambiente['SEGREDO_DA_SESSAO_ANTERIOR'] ?? '').trim()
  return { atual, anterior: anterior.length >= SEGREDO_MAIS_CURTO ? anterior : null }
}

/** O remetente e o endereço das respostas, quando o ambiente não diz outros (B da área do cliente). */
export const REMETENTE_PADRAO = 'naoresponda@gruponaveg.com.br'
export const RESPOSTAS_PADRAO = 'contato@gruponaveg.com.br'

const EMAIL = ['EMAIL_USUARIO', 'EMAIL_SENHA_DE_APP'] as const

/** O login e a senha de app juntos, ou nenhum — a mesma régua da proteção. */
function lerEnvioDeEmail(ambiente: Readonly<Record<string, string | undefined>>): ContaDeEnvio | null {
  const presentes = EMAIL.filter((chave) => (ambiente[chave] ?? '').trim().length > 0)
  if (presentes.length < EMAIL.length) {
    const faltando = EMAIL.filter((chave) => !presentes.includes(chave))
    console.warn(`cadastro de contas desligado: faltam ${faltando.join(', ')}`)
    return null
  }
  const ouPadrao = (chave: string, padrao: string) => {
    const valor = (ambiente[chave] ?? '').trim()
    return valor.length > 0 ? valor : padrao
  }
  return {
    usuario: (ambiente['EMAIL_USUARIO'] as string).trim(),
    /* A senha de app vem com espaços de quatro em quatro letras na tela do Google; o SMTP a quer sem eles. */
    senhaDeApp: (ambiente['EMAIL_SENHA_DE_APP'] as string).replace(/\s+/g, ''),
    remetente: ouPadrao('EMAIL_REMETENTE', REMETENTE_PADRAO),
    responderPara: ouPadrao('EMAIL_RESPONDER_PARA', RESPOSTAS_PADRAO),
  }
}

/** A chave Web, ou `null` com o aviso — a mesma régua da proteção: sem ela não há `POST`, e a partida diz. */
function lerChaveWeb(ambiente: Readonly<Record<string, string | undefined>>): string | null {
  const chave = (ambiente['FIREBASE_WEB_API_KEY'] ?? '').trim()
  if (chave.length === 0) {
    console.warn('envio de reservas desligado: falta FIREBASE_WEB_API_KEY')
    return null
  }
  return chave
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
