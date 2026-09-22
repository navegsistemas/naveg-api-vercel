/**
 * **A porta de entrada na Vercel.**
 *
 * A Vercel não roda um servidor de pé: ela invoca uma função por requisição. O `vercel.json` manda todo
 * caminho para cá, e o adaptador do Hono traduz a requisição da função no `Request` que o app entende — o
 * mesmo app que os cenários montam, sem Vercel nenhuma.
 *
 * **Runtime Node, nunca edge.** O `firebase-admin` depende de APIs de Node e não roda no edge; a Vercel usa
 * Node por padrão, e a única forma de errar isto é alguém declarar `edge` em algum lugar.
 *
 * A configuração é lida **uma vez por instância**, no escopo do módulo: invocações seguintes na mesma
 * instância reaproveitam, e a que falta uma variável falha na partida, não na requisição.
 */
import { handle } from '@hono/node-server/vercel'

import { criarApp } from '../src/app.js'
import { lerConfig } from '../src/config.js'

export default handle(criarApp({ config: lerConfig() }))
