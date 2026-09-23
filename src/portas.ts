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
