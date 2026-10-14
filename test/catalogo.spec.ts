/**
 * **`GET /catalogo`** — o aceite do passo 9, com portas falsas.
 *
 * O que se confere é a fronteira, não o domínio (o recorte e a serialização têm cenários no pacote deles): que
 * o que sai é o recorte, que a falta de concessão é falha e não catálogo vazio, que o cache só vai na resposta
 * boa, e que erro de infraestrutura não vaza.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  catalogoDoJson,
  catalogoParaJson,
  recortarPelaConcessao,
  type CatalogoDoFluviapp,
  type DataCalendario,
} from '@navegsistemas/domain'

import { criarApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { catalogoDoFirestore, type DocumentoLido, type FirestoreDeLeitura } from '../src/firestore/catalogo-firestore.js'
import type { LeitorDoCatalogo } from '../src/portas.js'
import { CACHE_DO_CATALOGO } from '../src/rotas/catalogo.js'

const CONFIG: Config = {
  projetoFirebase: 'fluviapp-teste',
  contaDeLeitura: '{}',
  contaDeEscrita: '{}',
  chaveWebDoFirebase: null,
  empresaId: 'empresa-naveg',
  origensPermitidas: ['https://agencia.naveg.com.br', 'http://localhost:4321'],
  protecaoDoEnvio: null,
}

const embarcacao = (id: string, nome: string, tipo: 'FERRY_BOAT' | 'LANCHA' | 'NAVIO', empresaId = 'naveg') => ({
  id, nome, tipo, capacidadeVeiculo: 0, capacidadeSuite2: 0, capacidadeSuite3: 0, capacidadeCamarote: 0, empresaId,
})

/* O cais é da viagem (fluviapp-kmp#51): a rota liga as cidades. */
const BEL_SOU = { portoEmbarqueId: 'p-bel', portoDesembarqueId: 'p-sou' }
const SOU_BEL = { portoEmbarqueId: 'p-sou', portoDesembarqueId: 'p-bel' }
const BEL_MAO = { portoEmbarqueId: 'p-bel', portoDesembarqueId: 'p-mao' }

/** O pool como está no banco: o que a NAVEG vende, e o que ela não vende por cinco motivos diferentes. */
const POOL: CatalogoDoFluviapp = {
  localidades: [
    { id: 'bel', municipio: 'Belém', uf: 'PA', codigoIbge: '1501402', ativo: true },
    { id: 'sou', municipio: 'Soure', uf: 'PA', codigoIbge: '1507904', ativo: true },
    { id: 'mao', municipio: 'Manaus', uf: 'AM', codigoIbge: '1302603', ativo: true },
  ],
  portos: [
    { id: 'p-bel', nome: 'Terminal Hidroviário', localidadeId: 'bel', ativo: true },
    { id: 'p-sou', nome: 'Porto de Camará', localidadeId: 'sou', ativo: true },
    { id: 'p-mao', nome: 'Porto de Manaus', localidadeId: 'mao', ativo: true },
  ],
  rotas: [
    { id: 'r-ida', localidadeOrigemId: 'bel', localidadeDestinoId: 'sou', distanciaMn: 40, tempoMedioH: 3.5, ativo: true },
    { id: 'r-volta-inativa', localidadeOrigemId: 'sou', localidadeDestinoId: 'bel', distanciaMn: 40, tempoMedioH: 3.5, ativo: false },
    { id: 'r-manaus', localidadeOrigemId: 'bel', localidadeDestinoId: 'mao', distanciaMn: 900, tempoMedioH: 96, ativo: true },
  ],
  embarcacoes: [embarcacao('e-ferry', 'Ferry', 'FERRY_BOAT'), embarcacao('e-alheio', 'Navio de Outra Agência', 'NAVIO', 'outra')],
  viagens: [
    { id: 'v-vende', rotaId: 'r-ida', embarcacaoId: 'e-ferry', diaSemana: 'WEDNESDAY', horaMin: 1080, ativo: true, ...BEL_SOU },
    { id: 'v-rota-inativa', rotaId: 'r-volta-inativa', embarcacaoId: 'e-ferry', diaSemana: 'THURSDAY', horaMin: 1080, ativo: true, ...SOU_BEL },
    { id: 'v-porto-fora', rotaId: 'r-manaus', embarcacaoId: 'e-ferry', diaSemana: 'FRIDAY', horaMin: 1080, ativo: true, ...BEL_MAO },
    { id: 'v-nao-concedida', rotaId: 'r-ida', embarcacaoId: 'e-alheio', diaSemana: 'MONDAY', horaMin: 1080, ativo: true, ...BEL_SOU },
    { id: 'v-embarcacao-some', rotaId: 'r-ida', embarcacaoId: 'e-apagada', diaSemana: 'TUESDAY', horaMin: 1080, ativo: true, ...BEL_SOU },
  ],
  atuacao: { embarcacaoIds: new Set(['e-ferry', 'e-apagada']), portoIds: new Set(['p-bel', 'p-sou']) },
  /* Uma da viagem que se vende, e uma de viagem alheia — que não sai do servidor. */
  suspensas: [
    { viagemId: 'v-vende', data: '2026-10-21' as DataCalendario },
    { viagemId: 'v-nao-concedida', data: '2026-10-19' as DataCalendario },
  ],
  /* A quarta de 14/10 sai às 19:00 (fluviapp-kmp#52); a de viagem alheia não sai do servidor. */
  alteracoes: [
    {
      ocorrencia: { viagemId: 'v-vende', data: '2026-10-14' as DataCalendario },
      portoEmbarqueId: 'p-bel',
      portoDesembarqueId: 'p-sou',
      horaMin: 19 * 60,
      motivo: 'Maré baixa',
    },
    {
      ocorrencia: { viagemId: 'v-nao-concedida', data: '2026-10-19' as DataCalendario },
      portoEmbarqueId: 'p-mao',
      portoDesembarqueId: 'p-sou',
      horaMin: 7 * 60,
      motivo: 'Alheia',
    },
  ],
}

const lendo = (catalogo: CatalogoDoFluviapp): LeitorDoCatalogo => ({ ler: async () => catalogo })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /catalogo', () => {
  it('responde o catálogo recortado pela concessão, na forma que o totem lê', async () => {
    const resposta = await criarApp({ config: CONFIG, catalogo: lendo(POOL), envio: null }).request('/catalogo')
    expect(resposta.status).toBe(200)

    const corpo: unknown = await resposta.json()
    expect(corpo).toEqual(JSON.parse(JSON.stringify(catalogoParaJson(recortarPelaConcessao(POOL)))))
    /* E o totem lê de volta, com a concessão de pé. */
    const lido = catalogoDoJson(corpo)
    expect(lido?.viagens.map((v) => v.id)).toEqual(['v-vende'])
    expect(lido?.atuacao?.embarcacaoIds.has('e-ferry')).toBe(true)
    /* A saída suspensa vai junto, para o calendário não acender a data (fluviapp-kmp#44). */
    expect(lido?.suspensas).toEqual([{ viagemId: 'v-vende', data: '2026-10-21' }])
    /* E a alteração da viagem que se vende, sem quem alterou (fluviapp-kmp#52). */
    expect(lido?.alteracoes.map((a) => [a.ocorrencia.viagemId, a.horaMin, a.motivo])).toEqual([['v-vende', 19 * 60, 'Maré baixa']])
  })

  it('o que a concessão não cobre não sai — nem rota inativa, nem embarcação que não resolve, nem o pool alheio', async () => {
    const resposta = await criarApp({ config: CONFIG, catalogo: lendo(POOL), envio: null }).request('/catalogo')
    const texto = await resposta.text()
    for (const fora of ['v-rota-inativa', 'r-volta-inativa', 'v-porto-fora', 'p-mao', 'Manaus', 'v-nao-concedida',
      'e-alheio', 'Navio de Outra Agência', 'v-embarcacao-some', 'e-apagada']) {
      expect(texto, fora).not.toContain(fora)
    }
  })

  it('cada leitura deixa uma linha de log com contagens — e nenhum id, nenhum nome', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    await criarApp({ config: CONFIG, catalogo: lendo(POOL), envio: null }).request('/catalogo')
    const linha = String(log.mock.calls[0]?.[0])
    expect(linha).toContain('pool: 5 viagens (5 ativas), 3 rotas (2 ativas), 3 portos, 2 embarcações, 2 datas alteradas')
    expect(linha).toContain('viagens ativas sem cais: 0')
    expect(linha).toContain('concessão: 2 embarcações e 2 portos')
    expect(linha).toContain('ofertável depois do recorte: 1 viagens')
    for (const dado of ['v-vende', 'e-ferry', 'p-bel', 'Belém', 'Ferry', 'empresa-naveg']) expect(linha).not.toContain(dado)
  })

  it('a resposta boa vai com o cache de borda', async () => {
    const resposta = await criarApp({ config: CONFIG, catalogo: lendo(POOL), envio: null }).request('/catalogo')
    expect(resposta.headers.get('cache-control')).toBe(CACHE_DO_CATALOGO)
  })

  it('sem concessão é 500 — e não um catálogo vazio, que seria um totem sem saídas com cara de funcionando', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const resposta = await criarApp({ config: CONFIG, catalogo: lendo({ ...POOL, atuacao: null }), envio: null }).request('/catalogo')
    expect(resposta.status).toBe(500)
    expect(await resposta.json()).toEqual({ erro: 'FALHA_INTERNA', mensagem: 'Falha interna' })
    expect(resposta.headers.get('cache-control')).toBeNull()
  })

  it('falha do banco é 500 sem detalhe — a mensagem do Firestore vai para o log, não para a resposta', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const falhando: LeitorDoCatalogo = {
      ler: () => Promise.reject(new Error('7 PERMISSION_DENIED: projects/fluvi-app-dev/databases/(default) viagens')),
    }
    const resposta = await criarApp({ config: CONFIG, catalogo: falhando, envio: null }).request('/catalogo')
    expect(resposta.status).toBe(500)
    const texto = await resposta.text()
    for (const vazamento of ['PERMISSION_DENIED', 'fluvi-app-dev', 'viagens', 'databases']) expect(texto).not.toContain(vazamento)
    expect(resposta.headers.get('cache-control')).toBeNull()
    expect(log).toHaveBeenCalled()
  })

  it('o CORS vale aqui também, e a resposta varia pela origem — o cache de borda não pode servir a origem de outro', async () => {
    const app = criarApp({ config: CONFIG, catalogo: lendo(POOL), envio: null })
    const daAgencia = await app.request('/catalogo', { headers: { Origin: 'http://localhost:4321' } })
    expect(daAgencia.headers.get('access-control-allow-origin')).toBe('http://localhost:4321')
    expect(daAgencia.headers.get('vary')).toMatch(/origin/i)

    const deFora = await app.request('/catalogo', { headers: { Origin: 'https://outro-site.com' } })
    expect(deFora.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('o adaptador do Firestore', () => {
  /** Um Firestore de mentira: coleções e documentos por caminho, e a lista do que foi pedido. */
  function firestore(colecoes: Record<string, Record<string, unknown>>, documentos: Record<string, unknown>) {
    const pedidos: string[] = []
    const db: FirestoreDeLeitura = {
      collection: (nome) => ({
        get: async () => {
          pedidos.push(nome)
          const docs: DocumentoLido[] = Object.entries(colecoes[nome] ?? {}).map(([id, dado]) => ({ id, data: () => dado }))
          return { docs }
        },
      }),
      doc: (caminho) => ({
        get: async () => {
          pedidos.push(caminho)
          return { exists: caminho in documentos, data: () => documentos[caminho] }
        },
      }),
    }
    return { db, pedidos }
  }

  const COLECOES = {
    viagens: {
      'v-1': {
        rotaId: 'r-1',
        embarcacaoId: 'e-1',
        diaSemana: 'WEDNESDAY',
        horaMin: 1080,
        portoEmbarqueId: 'p-1',
        portoDesembarqueId: 'p-2',
      },
      'v-dia-torto': { rotaId: 'r-1', embarcacaoId: 'e-1', diaSemana: 'QUARTA' },
    },
    rotas: {
      'r-1': { localidadeOrigemId: 'l-1', localidadeDestinoId: 'l-2', tempoMedioH: 2 },
      /* A rota de antes da migração, só com os portos, não é rota (fluviapp-kmp#51). */
      'r-legada': { portoOrigemId: 'p-1', portoDestinoId: 'p-2', tempoMedioH: 2 },
    },
    portos: { 'p-1': { nome: 'Cais', localidadeId: 'l-1' }, 'p-2': { nome: 'Trapiche', localidadeId: 'l-1' } },
    localidades: { 'l-1': { municipio: 'Belém', uf: 'PA' }, 'l-2': { municipio: 'Soure', uf: 'PA' } },
    embarcacoes: { 'e-1': { nome: 'Lancha', tipo: 'LANCHA' }, 'e-sem-tipo': { nome: 'Sem tipo' } },
    suspensoes: {
      'v-1@2026-10-21': { viagemId: 'v-1', data: '2026-10-21', empresaId: 'x', motivo: 'Círio', porId: 'u', em: '' },
      'sem-viagem': { data: '2026-10-21', motivo: 'torta' },
    },
    alteracoes: {
      'v-1@2026-10-14': {
        viagemId: 'v-1',
        data: '2026-10-14',
        empresaId: 'x',
        portoEmbarqueId: 'p-1',
        portoDesembarqueId: 'p-2',
        horaMin: 1140,
        motivo: 'Cais em obra',
        porId: 'u',
        em: '2026-10-12T10:00:00',
      },
      'sem-hora': { viagemId: 'v-1', data: '2026-10-21', portoEmbarqueId: 'p-1', portoDesembarqueId: 'p-2' },
    },
  }
  const CONCESSAO = 'empresas/empresa-naveg/atuacoes/AGENCIAMENTO'

  it('lê as cinco coleções, as suspensões, as alterações e a concessão da empresa configurada', async () => {
    const { db, pedidos } = firestore(COLECOES, { [CONCESSAO]: { embarcacaoIds: ['e-1'], portoIds: ['p-1', 'p-2'] } })
    await catalogoDoFirestore(db, 'empresa-naveg').ler()
    expect([...pedidos].sort()).toEqual(
      [CONCESSAO, 'alteracoes', 'embarcacoes', 'localidades', 'portos', 'rotas', 'suspensoes', 'viagens'].sort(),
    )
  })

  it('a suspensão entra só com a ocorrência — o motivo e quem suspendeu ficam no banco', async () => {
    const { db } = firestore(COLECOES, { [CONCESSAO]: { embarcacaoIds: ['e-1'], portoIds: ['p-1', 'p-2'] } })
    const catalogo = await catalogoDoFirestore(db, 'empresa-naveg').ler()
    expect(catalogo.suspensas).toEqual([{ viagemId: 'v-1', data: '2026-10-21' }])
  })

  it('a alteração entra com o cais, a hora e o motivo — quem alterou fica no banco, e a sem hora não entra', async () => {
    const { db } = firestore(COLECOES, { [CONCESSAO]: { embarcacaoIds: ['e-1'], portoIds: ['p-1', 'p-2'] } })
    const catalogo = await catalogoDoFirestore(db, 'empresa-naveg').ler()
    expect(catalogo.alteracoes).toEqual([
      {
        ocorrencia: { viagemId: 'v-1', data: '2026-10-14' },
        portoEmbarqueId: 'p-1',
        portoDesembarqueId: 'p-2',
        horaMin: 1140,
        motivo: 'Cais em obra',
      },
    ])
  })

  it('decodifica como o aplicativo: o documento que o aplicativo recusa não entra', async () => {
    const { db } = firestore(COLECOES, { [CONCESSAO]: { embarcacaoIds: ['e-1'], portoIds: ['p-1', 'p-2'] } })
    const catalogo = await catalogoDoFirestore(db, 'empresa-naveg').ler()
    expect(catalogo.viagens.map((v) => v.id)).toEqual(['v-1'])
    expect(catalogo.rotas.map((r) => r.id)).toEqual(['r-1'])
    expect(catalogo.embarcacoes.map((e) => e.id)).toEqual(['e-1'])
    expect([...(catalogo.atuacao?.portoIds ?? [])]).toEqual(['p-1', 'p-2'])
  })

  it('concessão que não existe é atuação nula — e a rota transforma isso em 500', async () => {
    const { db } = firestore(COLECOES, {})
    expect((await catalogoDoFirestore(db, 'empresa-naveg').ler()).atuacao).toBeNull()
  })
})
