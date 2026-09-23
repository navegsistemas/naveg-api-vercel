/**
 * **`GET /catalogo`** — o catálogo do fluviapp, recortado pela concessão da NAVEG.
 *
 * A rota é fina: lê pela porta, recorta com o domínio, serializa com o domínio, responde. O que ela decide é
 * só o que é dela:
 *
 * - **sem concessão é 500, e não um catálogo vazio.** A concessão ausente quer dizer `NAVEG_EMPRESA_ID` errado
 *   ou o cadastro do fluviapp incompleto — um defeito nosso. Responder `200` com nada seria um totem sem saídas
 *   com cara de funcionando, e ninguém procuraria o defeito;
 * - **o cache de borda** — `s-maxage=60, stale-while-revalidate=600`. O catálogo muda quando alguém cadastra
 *   uma viagem, não a cada pedido. A disponibilidade não é calculada aqui: o totem filtra as saídas pelo
 *   relógio, no navegador, a cada minuto — por isso o cache não faz saída vencida aparecer. Só a resposta boa
 *   leva o cabeçalho; erro não fica em cache;
 * - **o que sai é o recorte**: o pool das outras empresas não deixa o servidor.
 */
import { Hono } from 'hono'

import { catalogoParaJson, recortarPelaConcessao } from '@navegsistemas/domain'

import { ErroDaApi } from '../erros.js'
import type { LeitorDoCatalogo } from '../portas.js'

export const CACHE_DO_CATALOGO = 'public, s-maxage=60, stale-while-revalidate=600'

export function rotaDoCatalogo(leitor: LeitorDoCatalogo): Hono {
  const rota = new Hono()

  rota.get('/', async (c) => {
    const catalogo = await leitor.ler()

    if (catalogo.atuacao === null) {
      /* O detalhe vai para o log; a resposta é a falha interna de sempre — ver `erros.ts`. */
      console.error('catálogo sem concessão: a atuação AGENCIAMENTO da empresa configurada não existe')
      throw new ErroDaApi(500, 'FALHA_INTERNA', 'Falha interna')
    }

    c.header('Cache-Control', CACHE_DO_CATALOGO)
    return c.json(catalogoParaJson(recortarPelaConcessao(catalogo)))
  })

  return rota
}
