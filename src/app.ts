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
import { leitorComCache } from './catalogo-em-cache.js'
import type { LeitorDoCatalogo, Relogio } from './portas.js'
import { rotaDoCatalogo } from './rotas/catalogo.js'
import { rotaDaConta, type DependenciasDoCadastro } from './rotas/conta.js'
import { rotaDeEco } from './rotas/eco.js'
import { rotaDeReservas, type DependenciasDoEnvio } from './rotas/reservas.js'
import { rotaDeSaude } from './rotas/saude.js'
import { rotaDaSenha, type DependenciasDaSenha } from './rotas/senha.js'
import { rotaDaSessao, type DependenciasDoEntrar } from './rotas/sessao.js'

export interface Dependencias {
  readonly config: Config
  readonly catalogo: LeitorDoCatalogo
  /** O que o `POST /reservas` precisa. `null`: o envio não está configurado, e a rota responde `503`. */
  readonly envio: DependenciasDoEnvio | null
  /** O que o `POST /conta` precisa. Ausente ou `null`: o cadastro não está configurado, e a rota responde `503`. */
  readonly cadastro?: DependenciasDoCadastro | null
  /** O que entrar e a sessão precisam. Ausente ou `null`: entrar responde `503`; sair funciona sempre. */
  readonly entrar?: DependenciasDoEntrar | null
  /** O que o "Esqueci a senha" precisa. Ausente ou `null`: as duas rotas dele respondem `503`. */
  readonly senha?: DependenciasDaSenha | null
  readonly relogio?: Relogio
}

export function criarApp({
  config,
  catalogo,
  envio,
  cadastro = null,
  entrar = null,
  senha = null,
  relogio = () => new Date(),
}: Dependencias): Hono {
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
  app.route('/catalogo', rotaDoCatalogo(catalogo))
  app.route(
    '/reservas',
    rotaDeReservas({
      /* O `POST` não tem o cache da borda: guarda o catálogo um minuto na instância, o mesmo prazo. */
      catalogo: leitorComCache(catalogo, relogio),
      origensPermitidas: config.origensPermitidas,
      agenciaId: config.empresaId,
      relogio,
      envio,
    }),
  )
  app.route('/conta', rotaDaConta({ origensPermitidas: config.origensPermitidas, relogio, cadastro }))
  app.route('/conta', rotaDaSessao({ origensPermitidas: config.origensPermitidas, relogio, entrar }))
  app.route('/conta/senha', rotaDaSenha({ origensPermitidas: config.origensPermitidas, relogio, senha }))
  app.route('/eco', rotaDeEco())

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
