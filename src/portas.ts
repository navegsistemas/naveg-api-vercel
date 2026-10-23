/**
 * **As portas da API** — o que as rotas precisam do mundo.
 *
 * As rotas dependem destas interfaces, e não do Firestore. É o que deixa os cenários montarem o app com portas
 * falsas — sem rede, sem emulador, sem credencial — e o `api/index.ts` ser o único lugar que sabe que do outro
 * lado existe um banco.
 */
import type { CatalogoDoFluviapp, ContaDoCliente, EscritaDaConta, TipoDeLink } from '@navegsistemas/domain'

/**
 * O catálogo do fluviapp **inteiro**, como está no banco: o pool de todas as empresas e a concessão da NAVEG.
 * Quem recorta é a rota, com o domínio — a porta só lê.
 */
export interface LeitorDoCatalogo {
  ler(): Promise<CatalogoDoFluviapp>
}

/**
 * O desafio do Turnstile: o token veio de uma pessoa resolvendo o widget da agência? `false` é "não" — token
 * inválido, repetido, vencido ou de outro site. Falha de rede **lança**: sem conseguir perguntar, a resposta é
 * falha nossa, não "não".
 */
export interface VerificadorDoDesafio {
  verificar(token: string, ip: string): Promise<boolean>
}

/**
 * O limite de envios por IP. `registrar` conta mais um envio deste IP e diz se ele ainda cabe na janela. O IP
 * chega **já resumido** (hash): quem guarda o contador não precisa saber o endereço de ninguém.
 */
export interface LimitePorIp {
  registrar(ipResumido: string): Promise<boolean>
}

/**
 * Uma trava curta por chave: `travar` diz `true` a quem chegou primeiro e `false` a quem chegou enquanto ela vale.
 * É o que impede dois cadastros simultâneos com o mesmo e-mail (o duplo toque no botão) de virar duas contas. A
 * chave chega **já resumida**, como o IP.
 */
export interface TravaPorChave {
  travar(chaveResumida: string, segundos: number): Promise<boolean>
}

/** A senha está numa base de senhas vazadas? Falha de rede é `false`: a lista local continua valendo. */
export interface ConsultaDeSenhaVazada {
  vazada(senha: string): Promise<boolean>
}

/** O que só o servidor lê da conta: `contasDeCliente/{id}/segredos/acesso` (ADR-0003, seção 4). */
export interface SegredoDeAcesso {
  /** O resumo scrypt da senha (`conta/senha.ts`). */
  readonly resumoDaSenha: string
  /** Somar 1 tira a conta de todos os aparelhos (ADR-0003, seção 1). */
  readonly geracao: number
  /** Os erros de senha seguidos; o quinto bloqueia por 15 minutos (3.3, C). */
  readonly errosSeguidos: number
}

/** O link de confirmação guardado: `contasDeCliente/{id}/segredos/confirmacao` (ADR-0003, seções 3 e 4). */
export interface SegredoDeConfirmacao {
  /** O SHA-256 do código, em hexadecimal (`conta/codigo.ts`). O código mesmo só vai no e-mail. */
  readonly resumoDoCodigo: string
  /** Epoch millis. Depois dele, o link não vale (24 horas, 3.2, B). */
  readonly valeAte: number
}

/** O que a confirmação precisa saber da conta. */
export interface ContaParaConfirmar {
  readonly confirmadaEm: number | null
  /** `null`: não há link guardado — já usado, ou nunca mandado. */
  readonly confirmacao: SegredoDeConfirmacao | null
  /** A conta desativada confirma o e-mail, mas não entra (3.3, F). */
  readonly ativa: boolean
  /** A geração da sessão, para o cookie de quem confirma (3.2, C). */
  readonly geracao: number
}

/** O que um link pedido pelo e-mail precisa da conta: o "Reenviar" (3.2, B) e o "Esqueci a senha" (3.4). */
export interface ContaParaLink {
  readonly contaId: string
  /** Para o "Olá" do e-mail. */
  readonly nome: string
  readonly confirmada: boolean
  /** A desativada não recebe o link de troca: recebe o aviso (3.4, F). */
  readonly ativa: boolean
}

/** O link de troca de senha guardado: `segredos/trocaDeSenha` (ADR-0003, seção 3). A mesma forma do outro. */
export type SegredoDeTroca = SegredoDeConfirmacao

/** O que a senha nova precisa da conta (3.4). */
export interface ContaParaTrocarSenha {
  /** `null`: não há link guardado — já usado, ou nunca pedido. */
  readonly troca: SegredoDeTroca | null
  readonly ativa: boolean
  readonly confirmadaEm: number | null
  /** Tirar o bloqueio junto (3.3, C): quem trocou a senha provou que é a pessoa. */
  readonly bloqueadaAte: number | null
  readonly geracao: number
  /** Para o aviso da troca (3.4, D). */
  readonly nome: string
  readonly email: string
}

/** A troca, num lote só (3.4, C e E). */
export interface TrocaDeSenha {
  readonly resumoDaSenha: string
  /** A geração somada: todo cookie anterior deixa de valer (ADR-0003, seção 1). */
  readonly geracao: number
  /** Quando a conta ainda não tinha confirmado: o link de troca confirma o e-mail (3.4, E). */
  readonly confirmarEm: number | null
  readonly tirarBloqueio: boolean
}

/** O que entrar precisa da conta achada pelo e-mail (3.3). */
export interface ContaParaEntrar {
  readonly contaId: string
  readonly ativa: boolean
  readonly confirmada: boolean
  /** Epoch millis até quando as tentativas esperam, ou `null` (3.3, C). */
  readonly bloqueadaAte: number | null
  readonly acesso: SegredoDeAcesso
}

/** O que a sessão confere a cada pedido de quem entrou (ADR-0003, seção 1). */
export interface ContaDaSessao {
  readonly ativa: boolean
  readonly confirmada: boolean
  readonly geracao: number
}

/** As contas do site, no cadastro da agência. */
export interface ContasDoCliente {
  /** Já há conta com este e-mail (normalizado)? */
  existeComEmail(email: string): Promise<boolean>
  /**
   * Grava a conta, os segredos dela (a senha e o link de confirmação) e mais uma no resumo, **juntos**. Recebe o
   * lote do domínio (`loteDaContaNova`). `false`: o banco recusou, e o log diz o código.
   */
  criar(
    contaId: string,
    lote: readonly EscritaDaConta[],
    acesso: SegredoDeAcesso,
    confirmacao: SegredoDeConfirmacao,
    criadaEm: number,
  ): Promise<boolean>
  /** Espelha na conta o último link mandado, para o painel ver (fluviapp-kmp#71, caso 3). */
  registrarEnvio(contaId: string, tipo: TipoDeLink, em: number): Promise<void>
  /** A conta e o link guardado dela, ou `null` quando não há conta com este id (ou ela não tem a forma da regra). */
  paraConfirmar(contaId: string): Promise<ContaParaConfirmar | null>
  /**
   * Marca a conta como confirmada, apaga o link e soma uma nas `confirmadas` do resumo, **juntos**. `false`: o banco
   * recusou.
   */
  confirmar(contaId: string, em: number): Promise<boolean>
  /** A conta deste e-mail (normalizado), para mandar um link, ou `null` quando não há. */
  paraMandarLink(email: string): Promise<ContaParaLink | null>
  /** Troca o link guardado por um novo: o anterior deixa de valer (3.2, B). `false`: o banco recusou. */
  trocarConfirmacao(contaId: string, confirmacao: SegredoDeConfirmacao): Promise<boolean>
  /** Grava o link de troca de senha por cima do anterior (3.4, A). `false`: o banco recusou. */
  gravarTrocaDeSenha(contaId: string, troca: SegredoDeTroca): Promise<boolean>
  /** A conta e o link de troca guardado, ou `null` quando não há conta com este id. */
  paraTrocarSenha(contaId: string): Promise<ContaParaTrocarSenha | null>
  /**
   * A senha nova: o resumo e a geração nos segredos, os erros zerados, o link apagado (vale uma vez só) e, se for o
   * caso, a confirmação do e-mail e o bloqueio tirado, **juntos**. `false`: o banco recusou.
   */
  trocarSenha(contaId: string, troca: TrocaDeSenha): Promise<boolean>
  /** A conta deste e-mail (normalizado), com os segredos de acesso, ou `null` quando não há. */
  paraEntrar(email: string): Promise<ContaParaEntrar | null>
  /**
   * Um erro de senha: grava os erros seguidos nos segredos e, quando `bloqueadaAte` vem, o bloqueio na conta, onde o
   * painel o vê e pode liberar (`LIBERAR_TENTATIVAS`). `false`: o banco recusou.
   */
  registrarErroDeSenha(contaId: string, errosSeguidos: number, bloqueadaAte: number | null): Promise<boolean>
  /** A entrada certa: zera os erros seguidos e tira o bloqueio vencido, se houver. `false`: o banco recusou. */
  registrarEntrada(contaId: string, tinhaBloqueio: boolean): Promise<boolean>
  /** A conta e a geração da sessão, lidas em paralelo, ou `null` quando a conta não existe mais. */
  paraSessao(contaId: string): Promise<ContaDaSessao | null>
}

/**
 * O que Meus dados lê: a conta inteira e os segredos de acesso — a geração, para conferir o cookie na mesma leitura, e
 * o resumo da senha, para trocá-la com a atual (4.2, C).
 */
export interface ContaDosMeusDados {
  readonly conta: ContaDoCliente
  readonly acesso: SegredoDeAcesso
}

/** O que a pessoa corrige sozinha (4.2, A): já normalizado pelo domínio. */
export interface DadosCorrigidos {
  readonly nome: string
  readonly telefone: string
}

/**
 * **Meus dados** (4.2), numa porta própria: o mesmo adaptador das contas, mas os cenários das outras rotas não
 * precisam saber dela.
 */
export interface DadosDaConta {
  /** A conta e os segredos de acesso, ou `null` quando a conta não existe mais (ou não tem a forma da regra). */
  paraMeusDados(contaId: string): Promise<ContaDosMeusDados | null>
  /** Grava o nome e o celular. `false`: o banco recusou, e o log diz o código. */
  salvarDados(contaId: string, dados: DadosCorrigidos): Promise<boolean>
  /** Grava o pedido de troca de e-mail por cima do anterior (4.2, B). `false`: o banco recusou. */
  gravarTrocaDeEmail(contaId: string, troca: SegredoDeTrocaDeEmail): Promise<boolean>
  /** A conta e o pedido de troca guardado, ou `null` quando não há conta com este id. */
  paraTrocarEmail(contaId: string): Promise<ContaParaTrocarEmail | null>
  /**
   * O e-mail novo na conta e o pedido apagado (vale uma vez só), **juntos**; com `confirmarEm`, a conta por confirmar
   * fica confirmada, como no link de confirmação. `false`: o banco recusou.
   */
  trocarEmail(contaId: string, novoEmail: string, confirmarEm: number | null): Promise<boolean>
}

/**
 * O pedido de troca de e-mail guardado: `segredos/trocaDeEmail`. A forma dos outros links, mais o e-mail novo, que só
 * vale depois do link aberto (4.2, B).
 */
export interface SegredoDeTrocaDeEmail extends SegredoDeConfirmacao {
  readonly novoEmail: string
}

/** O que o link da troca de e-mail precisa da conta. */
export interface ContaParaTrocarEmail {
  /** `null`: não há pedido guardado — já usado, ou nunca feito. */
  readonly troca: SegredoDeTrocaDeEmail | null
  readonly ativa: boolean
  readonly confirmadaEm: number | null
}

/** Uma mensagem pronta para sair (`conta/emails.ts`). */
export interface MensagemDeEmail {
  readonly para: string
  readonly assunto: string
  readonly texto: string
  readonly html: string
}

/**
 * **O carteiro**: manda um e-mail pelo Google Workspace, de `naoresponda@gruponaveg.com.br`. `false`: não saiu, e o
 * log diz por quê — sem o endereço de ninguém. Não lança: um e-mail que não sai não desfaz uma conta já gravada.
 */
export interface CarteiroDeEmail {
  enviar(mensagem: MensagemDeEmail): Promise<boolean>
}

/** O relógio. Os cenários passam um fixo; o servidor, o do sistema. */
export type Relogio = () => Date
