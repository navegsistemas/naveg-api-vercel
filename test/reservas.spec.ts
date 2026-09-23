/**
 * **`POST /reservas`** — o aceite do passo 10, com portas falsas.
 *
 * O relógio está parado numa terça, 13/10/2026, 08:00 em Belém. A saída de quarta às 18:00 está ofertada; a de
 * terça às 07:00 já partiu. Cada cenário confere uma conferência da rota, e que ela para **antes** das mais
 * caras: nada chega ao desafio sem passar pelo limite, nada chega ao banco sem passar por tudo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  codigoValido,
  paraDominio,
  type CatalogoDoFluviapp,
  type PedidoDeReservaJson,
  type Reserva,
  type ReservaDocumento,
  type ReservaRepositorio,
  type ResultadoDaGravacao,
} from '@navegsistemas/domain'

import { criarApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import type { LeitorDoCatalogo, LimitePorIp, VerificadorDoDesafio } from '../src/portas.js'
import { LIMITE_DO_CORPO, type DependenciasDoEnvio } from '../src/rotas/reservas.js'

const ORIGEM = 'https://agencia.naveg.com.br'
const TERCA_8H_EM_BELEM = new Date('2026-10-13T11:00:00Z')

const CONFIG: Config = {
  projetoFirebase: 'fluviapp-teste',
  contaDeLeitura: '{}',
  contaDeEscrita: '{}',
  empresaId: 'empresa-naveg',
  origensPermitidas: [ORIGEM],
  protecaoDoEnvio: null,
}

const CATALOGO: CatalogoDoFluviapp = {
  localidades: [{ id: 'bel', municipio: 'Belém', uf: 'PA', codigoIbge: '1501402', ativo: true }],
  portos: [
    { id: 'p-a', nome: 'Terminal', localidadeId: 'bel', ativo: true },
    { id: 'p-b', nome: 'Cais', localidadeId: 'bel', ativo: true },
    { id: 'p-fora', nome: 'Fora', localidadeId: 'bel', ativo: true },
  ],
  rotas: [
    { id: 'r', portoOrigemId: 'p-a', portoDestinoId: 'p-b', distanciaMn: 10, tempoMedioH: 2, ativo: true },
    { id: 'r-fora', portoOrigemId: 'p-a', portoDestinoId: 'p-fora', distanciaMn: 10, tempoMedioH: 2, ativo: true },
  ],
  embarcacoes: [
    {
      id: 'e', nome: 'Ferry', tipo: 'FERRY_BOAT', capacidadeVeiculo: 10,
      capacidadeSuite2: 0, capacidadeSuite3: 0, capacidadeCamarote: 2, empresaId: 'naveg',
    },
  ],
  viagens: [
    { id: 'v-quarta', rotaId: 'r', embarcacaoId: 'e', diaSemana: 'WEDNESDAY', horaMin: 18 * 60, ativo: true },
    { id: 'v-terca-cedo', rotaId: 'r', embarcacaoId: 'e', diaSemana: 'TUESDAY', horaMin: 7 * 60, ativo: true },
    { id: 'v-fora', rotaId: 'r-fora', embarcacaoId: 'e', diaSemana: 'WEDNESDAY', horaMin: 18 * 60, ativo: true },
  ],
  atuacao: { embarcacaoIds: new Set(['e']), portoIds: new Set(['p-a', 'p-b']) },
}

const PEDIDO: PedidoDeReservaJson = {
  viagemId: 'v-quarta',
  data: '2026-10-14',
  respostas: {
    categoria: 'PASSAGEIRO',
    acomodacao: 'REDE',
    tipo: 'INTEIRA',
    cliente: { nome: 'Maria Souza', telefone: '(91) 98888-7777' },
  },
  desafio: 'token-bom',
}

/** O banco, em memória: guarda o documento e recusa código repetido — a semântica do `create`. */
class Banco implements ReservaRepositorio {
  readonly documentos = new Map<string, ReservaDocumento>()
  falhar = false
  constructor(private readonly ocupados: Set<string> = new Set()) {}
  async criar(reserva: Reserva): Promise<ResultadoDaGravacao> {
    if (this.falhar) return { caso: 'FALHA', motivo: 'o banco recusou a gravação' }
    if (this.ocupados.has(reserva.codigo) || this.documentos.has(reserva.codigo)) return { caso: 'CODIGO_EM_USO' }
    const { paraDocumento } = await import('@navegsistemas/domain')
    this.documentos.set(reserva.codigo, paraDocumento(reserva))
    return { caso: 'GRAVADA' }
  }
}

interface Cena {
  banco: Banco
  desafios: string[]
  ipsNoLimite: string[]
  leituras: number
  desafioPassa: boolean
  limitePassa: boolean
}

function montar(opcoes: { envio?: false; banco?: Banco; catalogo?: CatalogoDoFluviapp } = {}) {
  const cena: Cena = {
    banco: opcoes.banco ?? new Banco(),
    desafios: [],
    ipsNoLimite: [],
    leituras: 0,
    desafioPassa: true,
    limitePassa: true,
  }
  const catalogo: LeitorDoCatalogo = {
    ler: async () => {
      cena.leituras += 1
      return opcoes.catalogo ?? CATALOGO
    },
  }
  const desafio: VerificadorDoDesafio = {
    verificar: async (token) => {
      cena.desafios.push(token)
      return cena.desafioPassa
    },
  }
  const limite: LimitePorIp = {
    registrar: async (ip) => {
      cena.ipsNoLimite.push(ip)
      return cena.limitePassa
    },
  }
  const envio: DependenciasDoEnvio | null =
    opcoes.envio === false ? null : { repositorio: cena.banco, desafio, limite, salDoIp: 'sal-de-teste' }
  const app = criarApp({ config: CONFIG, catalogo, envio, relogio: () => TERCA_8H_EM_BELEM })

  const enviar = (corpo: unknown, cabecalhos: Record<string, string> = {}) =>
    app.request('/reservas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGEM, 'x-real-ip': '200.1.2.3', ...cabecalhos },
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    })
  return { cena, enviar }
}

let logs: string[]
beforeEach(() => {
  logs = []
  const guardar = (...partes: unknown[]) => void logs.push(partes.map(String).join(' '))
  vi.spyOn(console, 'info').mockImplementation(guardar)
  vi.spyOn(console, 'error').mockImplementation(guardar)
  vi.spyOn(console, 'warn').mockImplementation(guardar)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('o caminho feliz', () => {
  it('201 com o código do servidor e a reserva como foi gravada', async () => {
    const { cena, enviar } = montar()
    const resposta = await enviar(PEDIDO)
    expect(resposta.status).toBe(201)

    const { codigo, reserva } = (await resposta.json()) as { codigo: string; reserva: ReservaDocumento }
    expect(codigoValido(codigo)).toBe(true)
    expect(cena.banco.documentos.get(codigo)).toEqual(reserva)
    /* O totem lê a resposta com o mesmo codec que o aplicativo usa. */
    expect(paraDominio(codigo, reserva)).toMatchObject({
      codigo,
      status: 'RESERVADA',
      origem: 'TOTEM_WEB',
      agenciaId: 'empresa-naveg',
      cliente: { nome: 'Maria Souza', telefone: '5591988887777' },
      criadoEm: '2026-10-13T08:00:00',
      expiraEm: '2026-10-14T18:00:00',
    })
  })

  it('o que o servidor deriva, o corpo não decide — código, instante, status e agência mandados são ignorados', async () => {
    const { cena, enviar } = montar()
    const resposta = await enviar({
      ...PEDIDO,
      codigo: 'NVG-AAAAAA',
      criadoEm: '2020-01-01T00:00:00',
      status: 'CONVERTIDA',
      agenciaId: 'outra-agencia',
      respostas: { ...PEDIDO.respostas, observacao: 'texto livre' },
    })
    const { codigo } = (await resposta.json()) as { codigo: string }
    const gravado = cena.banco.documentos.get(codigo) as unknown as Record<string, unknown>
    expect(codigo).not.toBe('NVG-AAAAAA')
    expect(gravado).toMatchObject({ status: 'RESERVADA', agenciaId: 'empresa-naveg', criadoEm: '2026-10-13T08:00:00' })
    expect(gravado).not.toHaveProperty('observacao')
  })

  it('código em uso: gera outro e grava — nunca sobrescreve', async () => {
    const { cena, enviar } = montar()
    const primeira = (await (await enviar(PEDIDO)).json()) as { codigo: string }
    const antes = { ...cena.banco.documentos.get(primeira.codigo) }
    const segunda = (await (await enviar(PEDIDO)).json()) as { codigo: string }
    expect(segunda.codigo).not.toBe(primeira.codigo)
    expect(cena.banco.documentos.get(primeira.codigo)).toEqual(antes)
  })

  it('o log leva o código, nunca o nome nem o telefone', async () => {
    const { enviar } = montar()
    await enviar(PEDIDO)
    expect(logs.some((linha) => /reserva NVG-[0-9A-Z]{6} gravada/.test(linha))).toBe(true)
    for (const linha of logs) {
      expect(linha).not.toContain('Maria')
      expect(linha).not.toContain('98888')
    }
  })
})

describe('as conferências, na ordem', () => {
  it('sem origem, ou de outra origem: 403 — antes de ler o corpo', async () => {
    const { cena, enviar } = montar()
    for (const origem of ['https://outro-site.com', '']) {
      const resposta = await enviar(PEDIDO, { Origin: origem })
      expect(resposta.status).toBe(403)
      expect(((await resposta.json()) as { erro: string }).erro).toBe('ORIGEM_NAO_PERMITIDA')
    }
    expect(cena.ipsNoLimite).toEqual([])
  })

  it('envio não configurado: 503 — e o catálogo continua servindo', async () => {
    const { enviar } = montar({ envio: false })
    const resposta = await enviar(PEDIDO)
    expect(resposta.status).toBe(503)
    expect(((await resposta.json()) as { erro: string }).erro).toBe('ENVIO_INDISPONIVEL')
  })

  it('corpo que não é JSON, ou não é pedido: 400; grande demais: 413 — e o limite nem é contado', async () => {
    const { cena, enviar } = montar()
    expect((await enviar('{isto não é json')).status).toBe(400)
    const { desafio: _, ...semDesafio } = PEDIDO
    expect((await enviar(semDesafio)).status).toBe(400)
    expect((await enviar({ ...PEDIDO, respostas: { ...PEDIDO.respostas, acomodacao: 'XYZ' } })).status).toBe(400)
    expect((await enviar({ ...PEDIDO, lixo: 'x'.repeat(LIMITE_DO_CORPO) })).status).toBe(413)
    expect(cena.ipsNoLimite).toEqual([])
  })

  it('limite excedido: 429 — e o desafio nem é consultado', async () => {
    const { cena, enviar } = montar()
    cena.limitePassa = false
    const resposta = await enviar(PEDIDO)
    expect(resposta.status).toBe(429)
    expect(cena.desafios).toEqual([])
  })

  it('o limite recebe o IP resumido, e não o endereço', async () => {
    const { cena, enviar } = montar()
    await enviar(PEDIDO)
    expect(cena.ipsNoLimite).toHaveLength(1)
    expect(cena.ipsNoLimite[0]).not.toContain('200.1.2.3')
    expect(cena.ipsNoLimite[0]).toMatch(/^[0-9a-f]{32}$/)
  })

  it('desafio que não confere: 403 — e nada é lido do banco nem gravado', async () => {
    const { cena, enviar } = montar()
    cena.desafioPassa = false
    const resposta = await enviar(PEDIDO)
    expect(resposta.status).toBe(403)
    expect(((await resposta.json()) as { erro: string }).erro).toBe('DESAFIO_INVALIDO')
    expect(cena.leituras).toBe(0)
    expect(cena.banco.documentos.size).toBe(0)
  })
})

describe('a travessia, contra o catálogo ao vivo', () => {
  it('409 para o que não está ofertado agora: já partiu, fora da concessão, inexistente, data que não bate', async () => {
    const { cena, enviar } = montar()
    for (const [viagemId, data] of [
      ['v-terca-cedo', '2026-10-13'],
      ['v-fora', '2026-10-14'],
      ['v-que-nao-existe', '2026-10-14'],
      ['v-quarta', '2026-10-15'],
      ['v-quarta', '2026-12-30'],
    ] as const) {
      const resposta = await enviar({ ...PEDIDO, viagemId, data })
      expect(resposta.status, `${viagemId}@${data}`).toBe(409)
    }
    expect(cena.banco.documentos.size).toBe(0)
  })

  it('sem concessão: 500, e nada gravado', async () => {
    const { cena, enviar } = montar({ catalogo: { ...CATALOGO, atuacao: null } })
    expect((await enviar(PEDIDO)).status).toBe(500)
    expect(cena.banco.documentos.size).toBe(0)
  })
})

describe('a montagem', () => {
  it('respostas incompletas: 422 RESERVA_INCOMPLETA', async () => {
    const { cliente: _, ...semCliente } = PEDIDO.respostas
    const resposta = await montar().enviar({ ...PEDIDO, respostas: semCliente })
    expect(resposta.status).toBe(422)
    expect(((await resposta.json()) as { erro: string }).erro).toBe('RESERVA_INCOMPLETA')
  })

  it('respostas incoerentes: 422 com a pendência tipada que o totem sabe dizer', async () => {
    const resposta = await montar().enviar({
      ...PEDIDO,
      respostas: { ...PEDIDO.respostas, cliente: { nome: 'Maria', telefone: '3222-1111' } },
    })
    expect(resposta.status).toBe(422)
    expect(await resposta.json()).toMatchObject({ erro: 'RESERVA_INCOERENTE', pendencias: ['CLIENTE_TELEFONE'] })
  })

  it('o banco falhando: 500 sem detalhe', async () => {
    const banco = new Banco()
    banco.falhar = true
    const resposta = await montar({ banco }).enviar(PEDIDO)
    expect(resposta.status).toBe(500)
    expect(await resposta.json()).toEqual({ erro: 'FALHA_INTERNA', mensagem: 'Falha interna' })
  })
})
