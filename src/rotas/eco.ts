/**
 * **`GET /eco`** — o endereço que a API enxerga, devolvido a quem chamou.
 *
 * Existe para uma conferência só (a seção "A medida" da ADR-0003, no `naveg-front`): **um `X-Forwarded-For`
 * forjado por quem chama não pode passar pelo repasse `/api` do site.** Se passasse, um robô mandaria cada pedido
 * com um endereço inventado, e o limite por endereço deixaria de valer justo no cadastro e no login. Chama-se a
 * rota pelo site com um endereço falso no cabeçalho, e confere-se qual ela devolve.
 *
 * Devolve só o que quem chamou já tem — o próprio endereço, como a API o lê, e os três cabeçalhos de onde ele sai.
 * Nada do servidor, nada de outra pessoa. `no-store`: nenhum cache guarda o endereço de alguém para outro.
 */
import { Hono } from 'hono'

import { ipDaRequisicao } from '../protecao/ip.js'

export function rotaDeEco(): Hono {
  const rota = new Hono()
  rota.get('/', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json({
      ip: ipDaRequisicao((nome) => c.req.header(nome)),
      'x-real-ip': c.req.header('x-real-ip') ?? null,
      'x-forwarded-for': c.req.header('x-forwarded-for') ?? null,
      'x-vercel-forwarded-for': c.req.header('x-vercel-forwarded-for') ?? null,
    })
  })
  return rota
}
