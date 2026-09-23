/**
 * **Os adaptadores do envio** — o que cada um faz com o mundo de fora, sem sair para ele.
 *
 * Firestore, Cloudflare e Upstash entram como objetos e `fetch` falsos; o que se confere é o que cada adaptador
 * **pede** (caminho, corpo, cabeçalho) e o que ele **conclui** de cada resposta — inclusive das ruins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { InstanteLocal, montarReserva, DataCalendario, type CatalogoDoFluviapp, type Reserva } from '@navegsistemas/domain'

import { criarApp } from '../src/app.js'
import { leitorComCache } from '../src/catalogo-em-cache.js'
import { lerConfig } from '../src/config.js'
import { reservaNoFirestore, type FirestoreDeEscrita } from '../src/firestore/reserva-firestore.js'
import { ipDaRequisicao, resumirIp } from '../src/protecao/ip.js'
import { limiteNoUpstash } from '../src/protecao/limite-upstash.js'
import { desafioNaCloudflare, type Buscar } from '../src/protecao/turnstile.js'

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function reserva(codigo: string): Reserva {
  const montagem = montarReserva(
    { categoria: 'PASSAGEIRO', acomodacao: 'REDE', tipo: 'INTEIRA', cliente: { nome: 'Maria' } },
    {
      ocorrencia: { viagemId: 'v', data: DataCalendario.de('2026-10-14') as DataCalendario },
      tipoEmbarcacao: 'FERRY_BOAT',
      partida: InstanteLocal.de('2026-10-14T18:00') as InstanteLocal,
    },
    { codigo, criadoEm: InstanteLocal.de('2026-10-13T08:00') as InstanteLocal },
  )
  if (montagem.caso !== 'OK') throw new Error('exemplo incoerente')
  return montagem.reserva
}

function respondendo(...respostas: (() => Response)[]): { buscar: Buscar; pedidos: { url: string; init?: RequestInit }[] } {
  const pedidos: { url: string; init?: RequestInit }[] = []
  let i = 0
  return {
    pedidos,
    buscar: async (url, init) => {
      pedidos.push(init === undefined ? { url } : { url, init })
      const proxima = respostas[Math.min(i++, respostas.length - 1)] as () => Response
      return proxima()
    },
  }
}
const json = (corpo: unknown, status = 200) => () => new Response(JSON.stringify(corpo), { status })

describe('a reserva no Firestore', () => {
  it('create em reservas/{codigo}, com o documento do codec', async () => {
    const criados: { caminho: string; dado: object }[] = []
    const db: FirestoreDeEscrita = { doc: (caminho) => ({ create: async (dado) => void criados.push({ caminho, dado }) }) }
    expect(await reservaNoFirestore(db).criar(reserva('NVG-7K3QP2'))).toEqual({ caso: 'GRAVADA' })
    expect(criados[0]?.caminho).toBe('reservas/NVG-7K3QP2')
    expect(criados[0]?.dado).toMatchObject({ status: 'RESERVADA', viagemId: 'v', data: '2026-10-14' })
  })

  it('ALREADY_EXISTS é código em uso — é o que faz gerar outro, e nunca sobrescrever', async () => {
    const db: FirestoreDeEscrita = { doc: () => ({ create: () => Promise.reject(Object.assign(new Error('6 ALREADY_EXISTS'), { code: 6 })) }) }
    expect(await reservaNoFirestore(db).criar(reserva('NVG-7K3QP2'))).toEqual({ caso: 'CODIGO_EM_USO' })
  })

  it('qualquer outro erro é falha, com motivo genérico — e o log sem o nome de ninguém', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db: FirestoreDeEscrita = {
      doc: () => ({ create: () => Promise.reject(Object.assign(new Error('7 PERMISSION_DENIED: Maria'), { code: 7 })) }),
    }
    const resultado = await reservaNoFirestore(db).criar(reserva('NVG-7K3QP2'))
    expect(resultado).toEqual({ caso: 'FALHA', motivo: 'o banco recusou a gravação' })
    expect(String(log.mock.calls[0]?.[0])).toContain('NVG-7K3QP2')
    expect(String(log.mock.calls[0]?.[0])).not.toContain('Maria')
  })
})

describe('o desafio na Cloudflare', () => {
  it('manda segredo, token e IP ao siteverify, e passa com success', async () => {
    const { buscar, pedidos } = respondendo(json({ success: true, action: 'reserva' }))
    expect(await desafioNaCloudflare('segredo', buscar).verificar('token', '200.1.2.3')).toBe(true)
    expect(pedidos[0]?.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    const corpo = new URLSearchParams(String(pedidos[0]?.init?.body))
    expect(Object.fromEntries(corpo)).toEqual({ secret: 'segredo', response: 'token', remoteip: '200.1.2.3' })
  })

  it('não passa sem success, nem com o token de outro widget (outra ação)', async () => {
    for (const resposta of [{ success: false }, { success: true, action: 'login' }, {}]) {
      const { buscar } = respondendo(json(resposta))
      expect(await desafioNaCloudflare('segredo', buscar).verificar('token', 'ip'), JSON.stringify(resposta)).toBe(false)
    }
  })

  it('a Cloudflare fora do ar lança — é falha nossa, não da pessoa', async () => {
    const { buscar } = respondendo(json({}, 502))
    await expect(desafioNaCloudflare('segredo', buscar).verificar('token', 'ip')).rejects.toThrow()
  })
})

describe('o limite no Upstash', () => {
  it('INCR e EXPIRE NX numa ida só, com o token no cabeçalho', async () => {
    const { buscar, pedidos } = respondendo(json([{ result: 1 }, { result: 1 }]))
    expect(await limiteNoUpstash('https://redis.upstash.io/', 'tok', { teto: 3, janelaEmSegundos: 600 }, buscar).registrar('abc')).toBe(true)
    expect(pedidos[0]?.url).toBe('https://redis.upstash.io/pipeline')
    expect((pedidos[0]?.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok')
    expect(JSON.parse(String(pedidos[0]?.init?.body))).toEqual([
      ['INCR', 'naveg:reservas:abc'],
      ['EXPIRE', 'naveg:reservas:abc', '600', 'NX'],
    ])
  })

  it('cabe até o teto, e não depois', async () => {
    const regra = { teto: 3, janelaEmSegundos: 600 }
    for (const [contagem, cabe] of [[3, true], [4, false]] as const) {
      const { buscar } = respondendo(json([{ result: contagem }, { result: 0 }]))
      expect(await limiteNoUpstash('https://r', 't', regra, buscar).registrar('abc'), String(contagem)).toBe(cabe)
    }
  })

  it('o Upstash fora do ar deixa passar — o Turnstile segue de pé, e recusar todo mundo seria pior', async () => {
    for (const buscar of [respondendo(json({}, 500)).buscar, respondendo(json({ erro: 1 })).buscar]) {
      expect(await limiteNoUpstash('https://r', 't', undefined, buscar).registrar('abc')).toBe(true)
    }
  })
})

describe('o IP', () => {
  it('x-real-ip, senão o primeiro de x-forwarded-for, senão um balde só', () => {
    const cabecalhos = (valores: Record<string, string>) => (nome: string) => valores[nome]
    expect(ipDaRequisicao(cabecalhos({ 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }))).toBe('1.1.1.1')
    expect(ipDaRequisicao(cabecalhos({ 'x-forwarded-for': ' 2.2.2.2 , 3.3.3.3' }))).toBe('2.2.2.2')
    expect(ipDaRequisicao(cabecalhos({}))).toBe('sem-ip')
  })

  it('o resumo é estável para o mesmo sal, muda com o sal, e não contém o endereço', () => {
    const resumo = resumirIp('200.1.2.3', 'sal')
    expect(resumirIp('200.1.2.3', 'sal')).toBe(resumo)
    expect(resumirIp('200.1.2.3', 'outro-sal')).not.toBe(resumo)
    expect(resumo).not.toContain('200')
  })
})

describe('o catálogo guardado por um minuto', () => {
  const CATALOGO = { viagens: [], rotas: [], portos: [], localidades: [], embarcacoes: [], atuacao: null } as CatalogoDoFluviapp

  it('lê uma vez por minuto, e de novo depois', async () => {
    let leituras = 0
    let agora = 0
    const leitor = leitorComCache({ ler: async () => (leituras++, CATALOGO) }, () => new Date(agora))
    await leitor.ler()
    agora = 59_999
    await leitor.ler()
    expect(leituras).toBe(1)
    agora = 60_000
    await leitor.ler()
    expect(leituras).toBe(2)
  })

  it('falha não fica guardada', async () => {
    let tentativas = 0
    const leitor = leitorComCache(
      { ler: async () => (tentativas++ === 0 ? Promise.reject(new Error('rede')) : CATALOGO) },
      () => new Date(0),
    )
    await expect(leitor.ler()).rejects.toThrow()
    await expect(leitor.ler()).resolves.toBe(CATALOGO)
  })
})

describe('a configuração do envio', () => {
  const BASE = {
    FIREBASE_PROJECT_ID: 'p',
    FIREBASE_CONTA_DE_LEITURA: '{}',
    FIREBASE_CONTA_DE_ESCRITA: '{}',
    NAVEG_EMPRESA_ID: 'e',
    ORIGENS_PERMITIDAS: 'http://localhost:4321',
  }
  const PROTECAO = { TURNSTILE_SECRET: 's', UPSTASH_REDIS_REST_URL: 'https://r', UPSTASH_REDIS_REST_TOKEN: 't' }

  it('as três juntas ligam o envio', () => {
    expect(lerConfig({ ...BASE, ...PROTECAO }).protecaoDoEnvio).toEqual({
      segredoDoTurnstile: 's',
      upstashUrl: 'https://r',
      upstashToken: 't',
    })
  })

  it('faltando qualquer uma, o envio fica desligado — e a partida diz qual falta, sem derrubar o catálogo', () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { UPSTASH_REDIS_REST_TOKEN: _, ...semToken } = PROTECAO
    expect(lerConfig({ ...BASE, ...semToken }).protecaoDoEnvio).toBeNull()
    expect(String(aviso.mock.calls[0]?.[0])).toContain('UPSTASH_REDIS_REST_TOKEN')
    expect(lerConfig(BASE).protecaoDoEnvio).toBeNull()
  })
})

describe('o CORS do POST', () => {
  it('o preflight da agência passa, com Content-Type liberado; o de outra origem, não', async () => {
    const app = criarApp({
      config: { ...lerConfig({
        FIREBASE_PROJECT_ID: 'p', FIREBASE_CONTA_DE_LEITURA: '{}', FIREBASE_CONTA_DE_ESCRITA: '{}',
        NAVEG_EMPRESA_ID: 'e', ORIGENS_PERMITIDAS: 'http://localhost:4321',
      }) },
      catalogo: { ler: () => Promise.reject(new Error('não devia ler')) },
      envio: null,
    })
    const preflight = (origem: string) =>
      app.request('/reservas', {
        method: 'OPTIONS',
        headers: { Origin: origem, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
      })

    const daAgencia = await preflight('http://localhost:4321')
    expect(daAgencia.status).toBe(204)
    expect(daAgencia.headers.get('access-control-allow-origin')).toBe('http://localhost:4321')
    expect(daAgencia.headers.get('access-control-allow-methods')).toContain('POST')
    expect(daAgencia.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('content-type')

    expect((await preflight('https://outro-site.com')).headers.get('access-control-allow-origin')).toBeNull()
  })
})
