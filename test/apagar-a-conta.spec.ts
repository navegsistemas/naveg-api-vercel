/**
 * **Apagar a conta em Meus dados** (o PR 10 da #30), com portas falsas e o scrypt de verdade.
 *
 * O relógio começa numa terça, 13/10/2026, 08:00 em Belém. O principal (4.2, E; O7): **a senha confirma**; vale **na
 * hora**, num lote só; a conta sai deste aparelho (o cookie) e de todos os outros (os segredos vão junto); e o aviso
 * sai para o e-mail.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataCalendario, type ContaDoCliente } from '@navegsistemas/domain'

import { criarApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { resumirSenha } from '../src/conta/senha.js'
import { NOME_DO_COOKIE, valorDaSessao } from '../src/conta/sessao.js'
import type {
  ContaDosMeusDados,
  ContasDoCliente,
  DadosDaConta,
  LeitorDoCatalogo,
  MensagemDeEmail,
  SegredoDeAcesso,
} from '../src/portas.js'
import { CONTA_APAGADA, type DependenciasDoApagar } from '../src/rotas/apagar.js'

const ORIGEM = 'https://agencia.naveg.com.br'
const TERCA_8H_EM_BELEM = new Date('2026-10-13T11:00:00Z')
const SENHA = 'rio e maré cheia'
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

let RESUMO: string
beforeAll(async () => {
  RESUMO = await resumirSenha(SENHA)
})

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

/** A conta da Maria, em memória: some de vez quando apagada. */
class Contas implements ContasDoCliente, DadosDaConta {
  conta: ContaDoCliente | null = MARIA
  acesso!: SegredoDeAcesso
  apagaFalha = false
  readonly apagadas: ContaDoCliente[] = []
  readonly erros: { errosSeguidos: number; bloqueadaAte: number | null }[] = []
  async paraMeusDados(contaId: string): Promise<ContaDosMeusDados | null> {
    return this.conta !== null && contaId === this.conta.id ? { conta: this.conta, acesso: this.acesso } : null
  }
  async apagarConta(conta: ContaDoCliente) {
    if (this.apagaFalha) return false
    this.apagadas.push(conta)
    this.conta = null
    return true
  }
  async registrarErroDeSenha(_: string, errosSeguidos: number, bloqueadaAte: number | null) {
    this.erros.push({ errosSeguidos, bloqueadaAte })
    this.acesso = { ...this.acesso, errosSeguidos }
    return true
  }
  async salvarDados() {
    return true
  }
  async gravarTrocaDeEmail() {
    return true
  }
  async paraTrocarEmail() {
    return null
  }
  async trocarEmail() {
    return true
  }
  async existeComEmail() {
    return false
  }
  async criar() {
    return true
  }
  async registrarEnvio() {}
  async paraConfirmar() {
    return null
  }
  async confirmar() {
    return true
  }
  async paraMandarLink() {
    return null
  }
  async trocarConfirmacao() {
    return true
  }
  async gravarTrocaDeSenha() {
    return true
  }
  async paraTrocarSenha() {
    return null
  }
  async trocarSenha() {
    return true
  }
  async paraEntrar() {
    return null
  }
  async registrarEntrada() {
    return true
  }
  async paraSessao() {
    return null
  }
}

function montar(opcoes: { apagar?: false } = {}) {
  const cena = {
    agora: TERCA_8H_EM_BELEM,
    contas: new Contas(),
    mandados: [] as MensagemDeEmail[],
    limitePassa: true,
    tarefas: [] as Promise<void>[],
  }
  cena.contas.acesso = { resumoDaSenha: RESUMO, geracao: 0, errosSeguidos: 0 }
  const catalogo: LeitorDoCatalogo = { ler: async () => Promise.reject(new Error('apagar não lê o catálogo')) }
  const apagar: DependenciasDoApagar = {
    contas: cena.contas,
    dados: cena.contas,
    segredos: SEGREDOS,
    limite: { registrar: async () => cena.limitePassa },
    carteiro: {
      enviar: async (mensagem) => {
        cena.mandados.push(mensagem)
        return true
      },
    },
    sal: 'sal-de-teste',
    emSegundoPlano: (tarefa) => void cena.tarefas.push(tarefa),
  }
  const app = criarApp({
    config: CONFIG,
    catalogo,
    envio: null,
    apagar: opcoes.apagar === false ? null : apagar,
    relogio: () => cena.agora,
  })
  const cookie = () =>
    `${NOME_DO_COOKIE}=${valorDaSessao({ contaId: 'conta-1', emitidaEm: cena.agora.getTime(), geracao: 0 }, SEGREDOS)}`
  const apagarCom = (corpo: unknown, cabecalhos: Record<string, string> = { Cookie: cookie() }) =>
    app.request('/conta/apagar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGEM, 'x-real-ip': '200.1.2.3', ...cabecalhos },
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    })
  return { cena, cookie, apagarCom }
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

describe('POST /conta/apagar — apagar a conta (4.2, E)', () => {
  it('com a senha: apaga, tira o cookie deste aparelho e manda o aviso', async () => {
    const { cena, apagarCom } = montar()
    const resposta = await apagarCom({ senha: SENHA })
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toEqual(CONTA_APAGADA)
    expect(resposta.headers.get('set-cookie')).toContain('Max-Age=0')
    /* A conta inteira vai ao adaptador: é dela que sai o índice do documento. */
    expect(cena.contas.apagadas).toEqual([MARIA])

    await Promise.all(cena.tarefas)
    expect(cena.mandados).toHaveLength(1)
    expect(cena.mandados[0]).toMatchObject({ para: 'maria@exemplo.com.br', assunto: 'Sua conta foi apagada' })
    expect(cena.mandados[0]?.texto).toContain('13/10/2026, 08:00')
    expect(logs).toContain('conta conta-1 apagada pela dona, em Meus dados')
    expect(logs.join('\n')).not.toContain('maria@')
  })

  it('o cookie de antes, depois de apagar, não vale mais: 401', async () => {
    const { cookie, apagarCom } = montar()
    const antes = cookie()
    await apagarCom({ senha: SENHA }, { Cookie: antes })
    expect((await apagarCom({ senha: SENHA }, { Cookie: antes })).status).toBe(401)
  })

  it('a senha errada: 403, o erro conta nas tentativas, e nada apagado', async () => {
    const { cena, apagarCom } = montar()
    const resposta = await apagarCom({ senha: 'não é esta' })
    expect(resposta.status).toBe(403)
    expect(await resposta.json()).toMatchObject({ erro: 'CREDENCIAIS_INVALIDAS' })
    expect(cena.contas.erros).toEqual([{ errosSeguidos: 1, bloqueadaAte: null }])
    expect(cena.contas.apagadas).toEqual([])
  })

  it('a conta esperando os 15 minutos: 429, nem com a senha certa', async () => {
    const { cena, apagarCom } = montar()
    cena.contas.conta = { ...MARIA, bloqueadaAte: cena.agora.getTime() + 60_000 }
    expect((await apagarCom({ senha: SENHA })).status).toBe(429)
    expect(cena.contas.apagadas).toEqual([])
  })

  it('sem quem entrou: 401, sem conferir a senha', async () => {
    const { cena, apagarCom } = montar()
    expect((await apagarCom({ senha: SENHA }, {})).status).toBe(401)
    expect(cena.contas.erros).toEqual([])
  })

  it('de outra origem: 403 ORIGEM_NAO_PERMITIDA', async () => {
    const { cena, cookie, apagarCom } = montar()
    const resposta = await apagarCom({ senha: SENHA }, { Cookie: cookie(), Origin: 'https://outro.site' })
    expect(await resposta.json()).toMatchObject({ erro: 'ORIGEM_NAO_PERMITIDA' })
    expect(cena.contas.apagadas).toEqual([])
  })

  it('endereço com pedidos demais: 429 LIMITE_EXCEDIDO', async () => {
    const { cena, apagarCom } = montar()
    cena.limitePassa = false
    expect(await (await apagarCom({ senha: SENHA })).json()).toMatchObject({ erro: 'LIMITE_EXCEDIDO' })
  })

  it.each([
    ['vazio', ''],
    ['sem a senha', JSON.stringify({})],
    ['com a senha longa demais', JSON.stringify({ senha: 'a'.repeat(129) })],
  ])('o corpo %s: 400', async (_, corpo) => {
    const { apagarCom } = montar()
    expect((await apagarCom(corpo)).status).toBe(400)
  })

  it('o banco recusa: 500, o cookie fica e nenhum aviso sai', async () => {
    const { cena, apagarCom } = montar()
    cena.contas.apagaFalha = true
    const resposta = await apagarCom({ senha: SENHA })
    expect(resposta.status).toBe(500)
    expect(resposta.headers.get('set-cookie')).toBeNull()
    expect(cena.tarefas).toEqual([])
  })

  it('sem apagar configurado: 503', async () => {
    const { apagarCom } = montar({ apagar: false })
    expect((await apagarCom({ senha: SENHA })).status).toBe(503)
  })
})
