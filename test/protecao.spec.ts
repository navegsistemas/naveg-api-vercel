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
import { reservaNoFirestore, type Escrita, type LoteDeCriacao } from '../src/firestore/reserva-firestore.js'
import { claimsDoServico, sessaoDoServico, UID_DO_SERVICO } from '../src/firestore/servico.js'
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

describe('a reserva no Firestore, sob as Rules', () => {
  function lote(resultado: () => Promise<'CRIADOS' | 'JA_EXISTE'>): LoteDeCriacao & { escritas: Escrita[] } {
    const escritas: Escrita[] = []
    return {
      escritas,
      criarJuntos: (novas) => {
        escritas.push(...novas)
        return resultado()
      },
    }
  }

  it('grava a reserva e o reserva.criada juntos — a reserva primeiro, que é o que se confere livre', async () => {
    const banco = lote(async () => 'CRIADOS')
    expect(await reservaNoFirestore(banco, UID_DO_SERVICO).criar(reserva('NVG-7K3QP2'))).toEqual({ caso: 'GRAVADA' })

    expect(banco.escritas.map((e) => e.caminho)).toEqual(['reservas/NVG-7K3QP2', 'eventos/reserva.criada:NVG-7K3QP2'])
    expect(banco.escritas[0]?.dado).toMatchObject({ status: 'RESERVADA', viagemId: 'v', data: '2026-10-14' })
    expect(banco.escritas[1]?.dado).toEqual({
      tipo: 'reserva.criada',
      entidade: { colecao: 'reservas', id: 'NVG-7K3QP2' },
      agenciaId: '',
      origem: 'api-agencia',
      severidade: 'INFO',
      porId: 'naveg-api',
      em: '2026-10-13T08:00:00',
      dados: { de: '', para: 'RESERVADA' },
    })
  })

  it('o evento não leva o nome de quem reservou', async () => {
    const banco = lote(async () => 'CRIADOS')
    await reservaNoFirestore(banco, UID_DO_SERVICO).criar(reserva('NVG-7K3QP2'))
    expect(JSON.stringify(banco.escritas[1]?.dado)).not.toContain('Maria')
  })

  it('código que já existe é código em uso — é o que faz gerar outro, e nunca sobrescrever', async () => {
    const banco = lote(async () => 'JA_EXISTE')
    expect(await reservaNoFirestore(banco, UID_DO_SERVICO).criar(reserva('NVG-7K3QP2'))).toEqual({ caso: 'CODIGO_EM_USO' })
  })

  it('qualquer erro é falha, com motivo genérico — e o log sem o nome de ninguém', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const banco = lote(() => Promise.reject(Object.assign(new Error('Missing or insufficient permissions: Maria'), { code: 'permission-denied' })))
    const resultado = await reservaNoFirestore(banco, UID_DO_SERVICO).criar(reserva('NVG-7K3QP2'))
    expect(resultado).toEqual({ caso: 'FALHA', motivo: 'o banco recusou a gravação' })
    expect(String(log.mock.calls[0]?.[0])).toContain('NVG-7K3QP2')
    expect(String(log.mock.calls[0]?.[0])).toContain('permission-denied')
    expect(String(log.mock.calls[0]?.[0])).not.toContain('Maria')
  })
})

describe('a sessão do usuário de serviço', () => {
  it('o token leva o uid do serviço, o papel e a agência — as claims que as Rules conferem', async () => {
    const pedidos: unknown[] = []
    const obter = sessaoDoServico('empresa-naveg', {
      emitirToken: async (uid, claims) => {
        pedidos.push({ uid, claims })
        return 'token'
      },
      entrar: async () => ({}) as never,
    })
    await obter()
    expect(pedidos).toEqual([{ uid: 'naveg-api', claims: { papel: 'SERVICO', agenciaId: 'empresa-naveg' } }])
    expect(claimsDoServico('x')).toEqual({ papel: 'SERVICO', agenciaId: 'x' })
  })

  it('entra uma vez por instância, e reaproveita a sessão', async () => {
    let entradas = 0
    const obter = sessaoDoServico('empresa-naveg', {
      emitirToken: async () => 'token',
      entrar: async () => {
        entradas += 1
        return {} as never
      },
    })
    await Promise.all([obter(), obter()])
    await obter()
    expect(entradas).toBe(1)
  })

  it('uma falha no login não fica guardada — a próxima gravação tenta de novo', async () => {
    let tentativas = 0
    const obter = sessaoDoServico('empresa-naveg', {
      emitirToken: async () => 'token',
      entrar: async () => {
        tentativas += 1
        if (tentativas === 1) throw new Error('rede')
        return {} as never
      },
    })
    await expect(obter()).rejects.toThrow('rede')
    await expect(obter()).resolves.toBeDefined()
    expect(tentativas).toBe(2)
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
