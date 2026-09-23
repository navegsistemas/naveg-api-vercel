/**
 * **As portas da API** — o que as rotas precisam do mundo.
 *
 * As rotas dependem destas interfaces, e não do Firestore. É o que deixa os cenários montarem o app com portas
 * falsas — sem rede, sem emulador, sem credencial — e o `api/index.ts` ser o único lugar que sabe que do outro
 * lado existe um banco.
 */
import type { CatalogoDoFluviapp } from '@navegsistemas/domain'

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

/** O relógio. Os cenários passam um fixo; o servidor, o do sistema. */
export type Relogio = () => Date
