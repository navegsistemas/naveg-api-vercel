/**
 * **Meus dados** (o PR 9a da #30), com portas falsas.
 *
 * O relógio começa numa terça, 13/10/2026, 08:00 em Belém. O principal: **só quem entrou** lê e corrige, com o cookie
 * conferido como o `GET /conta/sessao` confere (a assinatura, a conta ativa, a geração); o documento volta **sempre
 * mascarado** (4.2, D); e a pessoa corrige o nome e o celular, e nada mais (4.2, A).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataCalendario, type ContaDoCliente } from '@navegsistemas/domain'

import { criarApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { NOME_DO_COOKIE, RENOVAR_DEPOIS_DE_MS, valorDaSessao } from '../src/conta/sessao.js'
import type { ContaDosMeusDados, DadosCorrigidos, DadosDaConta, LeitorDoCatalogo } from '../src/portas.js'

const ORIGEM = 'https://agencia.naveg.com.br'
const TERCA_8H_EM_BELEM = new Date('2026-10-13T11:00:00Z')
const SEGREDOS = { atual: 's'.repeat(43), anterior: null }

const CONFIG: Config = {
  projetoFirebase: 'fluviapp-teste',
  contaDeLeitura: '{}',
  contaDeEscrita: '{}',
  chaveWebDoFirebase: null,
  empresaId: 'empresa-naveg',
  origensPermitidas: [ORIGEM],
  protecaoDoEnvio: null,
}

const MARIA: ContaDoCliente = {
  id: 'conta-1',
  nome: 'Maria Souza',
  email: 'maria@exemplo.com.br',
  telefone: '5591988887777',
  dataNascimento: DataCalendario.de('1990-05-20') as DataCalendario,
  documento: { tipo: 'CPF', numero: '52998224725' },
  criadaEm: 1_792_000_000_000,
  confirmadaEm: 1_792_000_100_000,
  ativa: true,
  ultimoEnvio: null,
  bloqueadaAte: null,
  envioPorEmail: null,
  envioPorWhatsapp: null,
}

/** A conta da Maria, em memória, com o que Meus dados lê e grava. */
class Dados implements DadosDaConta {
  conta: ContaDoCliente | null = MARIA
  geracao = 0
  gravacaoFalha = false
  readonly gravados: DadosCorrigidos[] = []
  async paraMeusDados(contaId: string): Promise<ContaDosMeusDados | null> {
    if (this.conta === null || contaId !== this.conta.id) return null
    return { conta: this.conta, geracao: this.geracao }
  }
  async salvarDados(_: string, dados: DadosCorrigidos) {
    if (this.gravacaoFalha) return false
    this.gravados.push(dados)
    if (this.conta !== null) this.conta = { ...this.conta, ...dados }
    return true
  }
}

function montar(opcoes: { dados?: false } = {}) {
  const cena = { agora: TERCA_8H_EM_BELEM, dados: new Dados() }
  const catalogo: LeitorDoCatalogo = { ler: async () => Promise.reject(new Error('Meus dados não lê o catálogo')) }
  const app = criarApp({
    config: CONFIG,
    catalogo,
    envio: null,
    dados: opcoes.dados === false ? null : { dados: cena.dados, segredos: SEGREDOS },
    relogio: () => cena.agora,
  })
  /** O cookie da Maria, emitido agora, com a geração dada. */
  const cookie = (geracao = 0, emitidaEm = cena.agora.getTime(), contaId = 'conta-1') =>
    `${NOME_DO_COOKIE}=${valorDaSessao({ contaId, emitidaEm, geracao }, SEGREDOS)}`
  const ler = (cabecalhos: Record<string, string> = {}) => app.request('/conta/dados', { headers: cabecalhos })
  const salvar = (corpo: unknown, cabecalhos: Record<string, string> = {}) =>
    app.request('/conta/dados', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGEM, ...cabecalhos },
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    })
  return { cena, cookie, ler, salvar }
}

let logs: string[]
beforeEach(() => {
  logs = []
  const guardar = (...partes: unknown[]) => void logs.push(partes.map(String).join(' '))
  vi.spyOn(console, 'info').mockImplementation(guardar)
  vi.spyOn(console, 'error').mockImplementation(guardar)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /conta/dados — o que a conta mostra (4.1, D; 4.2)', () => {
  it('quem entrou recebe os dados, com o documento mascarado e sem cache', async () => {
    const { cookie, ler } = montar()
    const resposta = await ler({ Cookie: cookie() })
    expect(resposta.status).toBe(200)
    expect(resposta.headers.get('cache-control')).toBe('no-store')
    expect(await resposta.json()).toEqual({
      nome: 'Maria Souza',
      email: 'maria@exemplo.com.br',
      telefone: '5591988887777',
      dataNascimento: '1990-05-20',
      documento: 'CPF ###.###.247-25',
      confirmada: true,
    })
  })

  it('o documento inteiro não volta, nem para o dono (O12)', async () => {
    const { cookie, ler } = montar()
    expect(await (await ler({ Cookie: cookie() })).text()).not.toContain('52998224725')
  })

  it('antes da primeira compra, o documento é `null`; por confirmar, `confirmada: false`', async () => {
    const { cena, cookie, ler } = montar()
    cena.dados.conta = { ...MARIA, documento: null, confirmadaEm: null }
    expect(await (await ler({ Cookie: cookie() })).json()).toMatchObject({ documento: null, confirmada: false })
  })

  it('sem cookie: 401 SEM_SESSAO, sem ler o banco', async () => {
    const { cena, ler } = montar()
    const lidas = vi.spyOn(cena.dados, 'paraMeusDados')
    const resposta = await ler()
    expect(resposta.status).toBe(401)
    expect(await resposta.json()).toMatchObject({ erro: 'SEM_SESSAO' })
    expect(resposta.headers.get('set-cookie')).toBeNull()
    expect(lidas).not.toHaveBeenCalled()
  })

  it.each([
    ['de outra geração (a senha trocada noutro aparelho)', (m: ReturnType<typeof montar>) => m.cookie(1)],
    ['vencido (mais de 14 dias)', (m: ReturnType<typeof montar>) => m.cookie(0, m.cena.agora.getTime() - 15 * 86_400_000)],
    ['de conta que não existe mais', (m: ReturnType<typeof montar>) => m.cookie(0, undefined, 'conta-apagada')],
    ['adulterado', (m: ReturnType<typeof montar>) => `${m.cookie()}x`],
  ])('o cookie %s: 401, e o cookie sai do aparelho', async (_, cookieDe) => {
    const m = montar()
    const resposta = await m.ler({ Cookie: cookieDe(m) })
    expect(resposta.status).toBe(401)
    expect(resposta.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('a conta desativada pelo atendimento: 401, como a sessão', async () => {
    const { cena, cookie, ler } = montar()
    cena.dados.conta = { ...MARIA, ativa: false }
    expect((await ler({ Cookie: cookie() })).status).toBe(401)
  })

  it('o cookie de mais de um dia é renovado; o de hoje, não', async () => {
    const { cena, cookie, ler } = montar()
    const deOntem = cookie(0, cena.agora.getTime() - RENOVAR_DEPOIS_DE_MS - 1)
    expect((await ler({ Cookie: deOntem })).headers.get('set-cookie')).toContain('Max-Age=1209600')
    expect((await ler({ Cookie: cookie() })).headers.get('set-cookie')).toBeNull()
  })

  it('sem a sessão configurada: 503', async () => {
    const { ler } = montar({ dados: false })
    const resposta = await ler()
    expect(resposta.status).toBe(503)
    expect(await resposta.json()).toMatchObject({ erro: 'ENTRAR_INDISPONIVEL' })
  })
})

describe('POST /conta/dados — o "Salvar alterações" (4.2, A e F)', () => {
  it('grava o nome e o celular normalizados, e devolve os dados como ficaram', async () => {
    const { cena, cookie, salvar } = montar()
    const resposta = await salvar({ nome: '  Maria   Souza Lima ', telefone: '(91) 99111-2222' }, { Cookie: cookie() })
    expect(resposta.status).toBe(200)
    expect(cena.dados.gravados).toEqual([{ nome: 'Maria Souza Lima', telefone: '5591991112222' }])
    expect(await resposta.json()).toMatchObject({
      nome: 'Maria Souza Lima',
      telefone: '5591991112222',
      documento: 'CPF ###.###.247-25',
    })
    expect(logs).toContain('conta conta-1: nome e celular salvos')
    expect(logs.join('\n')).not.toContain('Maria')
  })

  it('o "Salvar" sem mudança não grava nada', async () => {
    const { cena, cookie, salvar } = montar()
    const resposta = await salvar({ nome: 'Maria Souza', telefone: '(91) 98888-7777' }, { Cookie: cookie() })
    expect(resposta.status).toBe(200)
    expect(cena.dados.gravados).toEqual([])
  })

  it('o nome vazio e o celular errado: 422, campo por campo, e nada gravado', async () => {
    const { cena, cookie, salvar } = montar()
    const resposta = await salvar({ nome: '   ', telefone: '9888-7777' }, { Cookie: cookie() })
    expect(resposta.status).toBe(422)
    expect(await resposta.json()).toMatchObject({ erro: 'CADASTRO_INVALIDO', pendencias: ['NOME', 'TELEFONE'] })
    expect(cena.dados.gravados).toEqual([])
  })

  it('o nome longo demais: 422 NOME', async () => {
    const { cookie, salvar } = montar()
    const resposta = await salvar({ nome: 'a'.repeat(121), telefone: '91988887777' }, { Cookie: cookie() })
    expect(await resposta.json()).toMatchObject({ pendencias: ['NOME'] })
  })

  it('o nascimento, o documento e o e-mail no corpo são ignorados (4.2, A)', async () => {
    const { cena, cookie, salvar } = montar()
    const corpo = {
      nome: 'Maria Lima',
      telefone: '91988887777',
      email: 'outra@exemplo.com.br',
      dataNascimento: '2000-01-01',
      documento: { tipo: 'CPF', numero: '11144477735' },
    }
    const resposta = await salvar(corpo, { Cookie: cookie() })
    expect(cena.dados.gravados).toEqual([{ nome: 'Maria Lima', telefone: '5591988887777' }])
    expect(await resposta.json()).toMatchObject({ email: 'maria@exemplo.com.br', dataNascimento: '1990-05-20' })
  })

  it('sem quem entrou: 401, e nada gravado', async () => {
    const { cena, salvar } = montar()
    expect((await salvar({ nome: 'Maria', telefone: '91988887777' })).status).toBe(401)
    expect(cena.dados.gravados).toEqual([])
  })

  it('de outra origem: 403, antes de tudo', async () => {
    const { cena, cookie, salvar } = montar()
    const resposta = await salvar({ nome: 'Maria', telefone: '91988887777' }, { Cookie: cookie(), Origin: 'https://outro.site' })
    expect(resposta.status).toBe(403)
    expect(cena.dados.gravados).toEqual([])
  })

  it.each([
    ['vazio', ''],
    ['sem o celular', JSON.stringify({ nome: 'Maria' })],
    ['com o nome em número', JSON.stringify({ nome: 1, telefone: '91988887777' })],
  ])('o corpo %s: 400', async (_, corpo) => {
    const { cookie, salvar } = montar()
    expect((await salvar(corpo, { Cookie: cookie() })).status).toBe(400)
  })

  it('o banco recusa: 500, sem detalhe', async () => {
    const { cena, cookie, salvar } = montar()
    cena.dados.gravacaoFalha = true
    const resposta = await salvar({ nome: 'Maria Lima', telefone: '91988887777' }, { Cookie: cookie() })
    expect(resposta.status).toBe(500)
    expect(await resposta.json()).toEqual({ erro: 'FALHA_INTERNA', mensagem: 'Falha interna' })
  })
})
