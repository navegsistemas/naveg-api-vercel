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
 * É o **único** arquivo que sabe que do outro lado há um Firestore, uma Cloudflare, um Upstash e o Gmail. A conta de
 * escrita só é usada quando o envio está configurado: sem desafio, limite e a chave Web não há `POST`, e sem
 * `POST` não há motivo para essa identidade existir em memória. E mesmo com ele, ela só **assina o token** com
 * que a API grava como usuário de serviço, sob as Rules do fluviapp (`src/firestore/servico.ts`).
 */
import { getRequestListener } from '@hono/node-server'
import { waitUntil } from '@vercel/functions'

import { criarApp } from '../src/app.js'
import { lerConfig } from '../src/config.js'
import { catalogoDoFirestore } from '../src/firestore/catalogo-firestore.js'
import { firestoreDaConta } from '../src/firestore/conexao.js'
import { senhaVazadaNoHibp } from '../src/conta/senha-fraca.js'
import { carteiroNoWorkspace } from '../src/email/smtp.js'
import { contasNoFirestore } from '../src/firestore/conta-firestore.js'
import { loteNoFirestore, reservaNoFirestore } from '../src/firestore/reserva-firestore.js'
import { sessaoDoServicoNoFirebase, UID_DO_SERVICO } from '../src/firestore/servico.js'
import { limiteNoUpstash, travaNoUpstash } from '../src/protecao/limite-upstash.js'
import { ACAO_DO_CADASTRO, ACAO_DO_ENTRAR, desafioNaCloudflare } from '../src/protecao/turnstile.js'
import { LIMITE_DO_REENVIO, type DependenciasDoCadastro } from '../src/rotas/conta.js'
import type { DependenciasDosDados } from '../src/rotas/dados.js'
import {
  ERROS_ATE_ESPERAR,
  ESPERA_DAS_TENTATIVAS_MS,
  type DependenciasDoEntrar,
} from '../src/rotas/sessao.js'
import type { DependenciasDoEnvio } from '../src/rotas/reservas.js'
import type { DependenciasDaSenha } from '../src/rotas/senha.js'

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
   contador dele; e o e-mail, porque uma conta que não recebe o link nunca se confirma. */
const contaDeEnvio = config.envioDeEmail ?? null
const segredosDaSessao = config.segredosDaSessao ?? null
const contas = servico === null ? null : contasNoFirestore(servico, config.empresaId)
const cadastro: DependenciasDoCadastro | null =
  protecao === null || contas === null || contaDeEnvio === null
    ? null
    : {
        contas,
        desafio: desafioNaCloudflare(protecao.segredoDoTurnstile, undefined, ACAO_DO_CADASTRO),
        limite: limiteNoUpstash(protecao.upstashUrl, protecao.upstashToken, undefined, undefined, 'naveg:cadastro'),
        trava: travaNoUpstash(protecao.upstashUrl, protecao.upstashToken, 'naveg:cadastro:email'),
        senhaVazada: senhaVazadaNoHibp(),
        carteiro: carteiroNoWorkspace(contaDeEnvio),
        sal: protecao.upstashToken,
        segredosDaSessao,
        limiteDoReenvio: limiteNoUpstash(
          protecao.upstashUrl,
          protecao.upstashToken,
          LIMITE_DO_REENVIO,
          undefined,
          'naveg:reenvio:email',
        ),
        /* Sem o `waitUntil`, a Vercel pode congelar a função assim que a resposta sai, com o e-mail por mandar. */
        emSegundoPlano: waitUntil,
      }

/* Entrar pede a sessão do serviço, a proteção e o segredo que assina o cookie. Os contadores são do entrar: o por
   IP, com o teto da reserva, e o do e-mail sem conta, com o teto das tentativas da conta (3.3, C). */
const entrar: DependenciasDoEntrar | null =
  protecao === null || contas === null || segredosDaSessao === null
    ? null
    : {
        contas,
        desafio: desafioNaCloudflare(protecao.segredoDoTurnstile, undefined, ACAO_DO_ENTRAR),
        limite: limiteNoUpstash(protecao.upstashUrl, protecao.upstashToken, undefined, undefined, 'naveg:entrar'),
        limiteDoEmail: limiteNoUpstash(
          protecao.upstashUrl,
          protecao.upstashToken,
          { teto: ERROS_ATE_ESPERAR - 1, janelaEmSegundos: ESPERA_DAS_TENTATIVAS_MS / 1000 },
          undefined,
          'naveg:entrar:email',
        ),
        segredos: segredosDaSessao,
        sal: protecao.upstashToken,
      }

/* O "Esqueci a senha" pede o que o cadastro pede (o e-mail sai) e o segredo da sessão (quem troca fica dentro). O
   limite por IP é o do cadastro; os 60 segundos e os 5 por hora, num contador só deste link. */
const senha: DependenciasDaSenha | null =
  protecao === null || contas === null || contaDeEnvio === null || segredosDaSessao === null
    ? null
    : {
        contas,
        limite: limiteNoUpstash(protecao.upstashUrl, protecao.upstashToken, undefined, undefined, 'naveg:cadastro'),
        trava: travaNoUpstash(protecao.upstashUrl, protecao.upstashToken, 'naveg:cadastro:email'),
        limiteDoPedido: limiteNoUpstash(
          protecao.upstashUrl,
          protecao.upstashToken,
          LIMITE_DO_REENVIO,
          undefined,
          'naveg:troca:email',
        ),
        senhaVazada: senhaVazadaNoHibp(),
        carteiro: carteiroNoWorkspace(contaDeEnvio),
        segredos: segredosDaSessao,
        sal: protecao.upstashToken,
        emSegundoPlano: waitUntil,
        /* A troca com a senha atual, em Meus dados (4.2, C). */
        dados: contas,
      }

/* Meus dados pede só quem entrou: a conta e o segredo que assina o cookie. */
const dados: DependenciasDosDados | null =
  contas === null || segredosDaSessao === null ? null : { dados: contas, segredos: segredosDaSessao }

/* O `handle` do `@hono/node-server/vercel` (1.x) era só isto, e a 2.x tirou o atalho: o ouvinte de requisição do
   Node, que traduz o `IncomingMessage` da função no `Request` do app. */
const app = criarApp({
  config,
  catalogo: catalogoDoFirestore(leitura, config.empresaId),
  envio,
  cadastro,
  entrar,
  senha,
  dados,
})

export default getRequestListener(app.fetch)
