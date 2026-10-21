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
import { getRequestListener } from '@hono/node-server'

import { criarApp } from '../src/app.js'
import { lerConfig } from '../src/config.js'
import { catalogoDoFirestore } from '../src/firestore/catalogo-firestore.js'
import { firestoreDaConta } from '../src/firestore/conexao.js'
import { senhaVazadaNoHibp } from '../src/conta/senha-fraca.js'
import { contasNoFirestore } from '../src/firestore/conta-firestore.js'
import { loteNoFirestore, reservaNoFirestore } from '../src/firestore/reserva-firestore.js'
import { sessaoDoServicoNoFirebase, UID_DO_SERVICO } from '../src/firestore/servico.js'
import { limiteNoUpstash, travaNoUpstash } from '../src/protecao/limite-upstash.js'
import { ACAO_DO_CADASTRO, desafioNaCloudflare } from '../src/protecao/turnstile.js'
import type { DependenciasDoCadastro } from '../src/rotas/conta.js'
import type { DependenciasDoEnvio } from '../src/rotas/reservas.js'

const config = lerConfig()
const leitura = firestoreDaConta('leitura', config.contaDeLeitura, config.projetoFirebase)

const protecao = config.protecaoDoEnvio
const chaveWeb = config.chaveWebDoFirebase
/* Uma sessão do serviço por instância, para a reserva e a conta: um login só. */
const servico =
  protecao === null || chaveWeb === null
    ? null
    : sessaoDoServicoNoFirebase({
        contaDeEscrita: config.contaDeEscrita,
        projeto: config.projetoFirebase,
        chaveWeb,
        agenciaId: config.empresaId,
      })

const envio: DependenciasDoEnvio | null =
  protecao === null || servico === null
    ? null
    : {
        repositorio: reservaNoFirestore(loteNoFirestore(servico), UID_DO_SERVICO),
        desafio: desafioNaCloudflare(protecao.segredoDoTurnstile),
        limite: limiteNoUpstash(protecao.upstashUrl, protecao.upstashToken),
        /* O token do Upstash já é segredo da implantação, e o contador vive no mesmo lugar que ele: trocar um
           reinicia o outro, que é o certo. */
        salDoIp: protecao.upstashToken,
      }

/* O cadastro pede as mesmas peças da reserva — o desafio, o limite e a sessão do serviço —, com a ação e o
   contador dele. */
const cadastro: DependenciasDoCadastro | null =
  protecao === null || servico === null
    ? null
    : {
        contas: contasNoFirestore(servico, config.empresaId),
        desafio: desafioNaCloudflare(protecao.segredoDoTurnstile, undefined, ACAO_DO_CADASTRO),
        limite: limiteNoUpstash(protecao.upstashUrl, protecao.upstashToken, undefined, undefined, 'naveg:cadastro'),
        trava: travaNoUpstash(protecao.upstashUrl, protecao.upstashToken, 'naveg:cadastro:email'),
        senhaVazada: senhaVazadaNoHibp(),
        sal: protecao.upstashToken,
      }

/* O `handle` do `@hono/node-server/vercel` (1.x) era só isto, e a 2.x tirou o atalho: o ouvinte de requisição do
   Node, que traduz o `IncomingMessage` da função no `Request` do app. */
const app = criarApp({ config, catalogo: catalogoDoFirestore(leitura, config.empresaId), envio, cadastro })

export default getRequestListener(app.fetch)
