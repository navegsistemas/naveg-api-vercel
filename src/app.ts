/**
 * **O app** — CORS, erro e as rotas. Nada de regra de negócio: ela mora no `@navegsistemas/domain`, e as rotas a
 * chamam.
 *
 * O app é **montado com a configuração**, e não a lê de dentro. É o que faz os cenários rodarem sem variável
 * de ambiente e sem Firestore: monta-se o app com uma configuração de teste e portas falsas.
 *
 * ### Por que CORS aqui, e não antes
 *
 * A API e o front são **origens diferentes** (a API tem domínio próprio). Sem `Access-Control-Allow-Origin`, o
 * navegador recusa a resposta antes de o totem vê-la. A lista de origens é explícita e vem do ambiente: um
 * `*` aqui deixaria qualquer página da internet mandar reservas em nome do site — e, sem cookie nenhum, o
 * estrago não seria roubo de sessão, seria volume.
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import type { Config } from './config.js'
import { ErroDaApi, type CorpoDeErro } from './erros.js'
import { rotaDeSaude } from './rotas/saude.js'

export interface Dependencias {
  readonly config: Config
}

export function criarApp({ config }: Dependencias): Hono {
  const app = new Hono()

  app.use(
    '*',
    cors({
      origin: (origem) => (config.origensPermitidas.includes(origem) ? origem : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 3600,
    }),
  )

  app.route('/saude', rotaDeSaude())

  app.notFound((c) => {
    const corpo: CorpoDeErro = { erro: 'CORPO_INVALIDO', mensagem: 'Rota inexistente' }
    return c.json(corpo, 404)
  })

  app.onError((erro, c) => {
    if (erro instanceof ErroDaApi) return c.json(erro.corpo(), erro.status)
    /* O que não foi previsto vira 500 **sem detalhe**: a mensagem original vai para o log, não para a
       resposta. Ver o cabeçalho de `erros.ts`. */
    console.error('falha não prevista', erro)
    const corpo: CorpoDeErro = { erro: 'FALHA_INTERNA', mensagem: 'Falha interna' }
    return c.json(corpo, 500)
  })

  return app
}
