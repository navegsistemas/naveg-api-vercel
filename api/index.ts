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
 * É o **único** arquivo que sabe que do outro lado há um Firestore, uma Cloudflare e um Upstash. A conta de
 * escrita só é usada quando o envio está configurado: sem desafio, limite e a chave Web não há `POST`, e sem
 * `POST` não há motivo para essa identidade existir em memória. E mesmo com ele, ela só **assina o token** com
 * que a API grava como usuário de serviço, sob as Rules do fluviapp (`src/firestore/servico.ts`).
 */
import { handle } from '@hono/node-server/vercel'

import { criarApp } from '../src/app.js'
import { lerConfig } from '../src/config.js'
import { catalogoDoFirestore } from '../src/firestore/catalogo-firestore.js'
import { firestoreDaConta } from '../src/firestore/conexao.js'
import { loteNoFirestore, reservaNoFirestore } from '../src/firestore/reserva-firestore.js'
import { sessaoDoServicoNoFirebase, UID_DO_SERVICO } from '../src/firestore/servico.js'
import { limiteNoUpstash } from '../src/protecao/limite-upstash.js'
import { desafioNaCloudflare } from '../src/protecao/turnstile.js'
import type { DependenciasDoEnvio } from '../src/rotas/reservas.js'

const config = lerConfig()
const leitura = firestoreDaConta('leitura', config.contaDeLeitura, config.projetoFirebase)

const protecao = config.protecaoDoEnvio
const chaveWeb = config.chaveWebDoFirebase
const envio: DependenciasDoEnvio | null =
  protecao === null || chaveWeb === null
    ? null
    : {
        repositorio: reservaNoFirestore(
          loteNoFirestore(
            sessaoDoServicoNoFirebase({
              contaDeEscrita: config.contaDeEscrita,
              projeto: config.projetoFirebase,
              chaveWeb,
              agenciaId: config.empresaId,
            }),
          ),
          UID_DO_SERVICO,
        ),
        desafio: desafioNaCloudflare(protecao.segredoDoTurnstile),
        limite: limiteNoUpstash(protecao.upstashUrl, protecao.upstashToken),
        /* O token do Upstash já é segredo da implantação, e o contador vive no mesmo lugar que ele: trocar um
           reinicia o outro, que é o certo. */
        salDoIp: protecao.upstashToken,
      }

export default handle(criarApp({ config, catalogo: catalogoDoFirestore(leitura, config.empresaId), envio }))
