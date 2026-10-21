/**
 * **As portas da API** — o que as rotas precisam do mundo.
 *
 * As rotas dependem destas interfaces, e não do Firestore. É o que deixa os cenários montarem o app com portas
 * falsas — sem rede, sem emulador, sem credencial — e o `api/index.ts` ser o único lugar que sabe que do outro
 * lado existe um banco.
 */
import type { CatalogoDoFluviapp, EscritaDaConta } from '@navegsistemas/domain'

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

/** As contas do site, no cadastro da agência. */
export interface ContasDoCliente {
  /** Já há conta com este e-mail (normalizado)? */
  existeComEmail(email: string): Promise<boolean>
  /**
   * Grava a conta, os segredos dela e mais uma no resumo, **juntos**. Recebe o lote do domínio
   * (`loteDaContaNova`). `false`: o banco recusou, e o log diz o código.
   */
  criar(contaId: string, lote: readonly EscritaDaConta[], acesso: SegredoDeAcesso, criadaEm: number): Promise<boolean>
}

/** O relógio. Os cenários passam um fixo; o servidor, o do sistema. */
export type Relogio = () => Date
