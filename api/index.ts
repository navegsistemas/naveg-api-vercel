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
 * A configuração e as conexões são criadas **uma vez por instância**, no escopo do módulo: invocações
 * seguintes na mesma instância reaproveitam, e a que falta uma variável — ou traz uma conta de outro projeto —
 * falha na partida, não na requisição.
 *
 * É o **único** arquivo que sabe que do outro lado há um Firestore. A conta de escrita ainda não é conectada:
 * ela entra com o `POST /reservas`, e até lá não há motivo para essa identidade existir em memória.
 */
import { handle } from '@hono/node-server/vercel'

import { criarApp } from '../src/app.js'
import { lerConfig } from '../src/config.js'
import { catalogoDoFirestore } from '../src/firestore/catalogo-firestore.js'
import { firestoreDaConta } from '../src/firestore/conexao.js'

const config = lerConfig()
const leitura = firestoreDaConta('leitura', config.contaDeLeitura, config.projetoFirebase)

export default handle(criarApp({ config, catalogo: catalogoDoFirestore(leitura, config.empresaId) }))
