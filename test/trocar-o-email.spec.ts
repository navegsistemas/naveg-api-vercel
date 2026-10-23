/**
 * **Trocar o e-mail em Meus dados** (o PR 9c da #30), com portas falsas e o scrypt de verdade.
 *
 * O relógio começa numa terça, 13/10/2026, 08:00 em Belém. O principal (4.2, B; PO, 2026-10-23): **a senha atual é a
 * prova**; **o novo só vale depois do link**; **o antigo é avisado já no pedido**; e **a resposta é a mesma** quando o
 * novo já é de outra conta — o dono desse endereço recebe o aviso do cadastro repetido, e só ele fica sabendo.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataCalendario, type ContaDoCliente } from '@navegsistemas/domain'

import { criarApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { PRAZO_DA_CONFIRMACAO_MS, resumirCodigo } from '../src/conta/codigo.js'
import { emailMascarado } from '../src/conta/emails.js'
import { resumirSenha } from '../src/conta/senha.js'
import { NOME_DO_COOKIE, valorDaSessao } from '../src/conta/sessao.js'
import type {
  ContaDosMeusDados,
  ContaParaTrocarEmail,
  ContasDoCliente,
  DadosDaConta,
  LeitorDoCatalogo,
  MensagemDeEmail,
  SegredoDeAcesso,
  SegredoDeTrocaDeEmail,
} from '../src/portas.js'
import { CONFIRA_O_EMAIL } from '../src/rotas/conta.js'
import { EMAIL_TROCADO, type DependenciasDoEmail } from '../src/rotas/email.js'

const ORIGEM = 'https://agencia.naveg.com.br'
const TERCA_8H_EM_BELEM = new Date('2026-10-13T11:00:00Z')
const SENHA = 'rio e maré cheia'
const SEGREDOS = { atual: 's'.repeat(43), anterior: null }
const CODIGO = 'c'.repeat(43)

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
  documento: null,
  criadaEm: 1_792_000_000_000,
  confirmadaEm: 1_792_000_100_000,
  ativa: true,
  ultimoEnvio: null,
  bloqueadaAte: null,
  envioPorEmail: null,
  envioPorWhatsapp: null,
}

/** A conta da Maria, em memória, e os e-mails que já têm conta. */
class Contas implements ContasDoCliente, DadosDaConta {
  conta: ContaDoCliente = MARIA
  acesso!: SegredoDeAcesso
  troca: SegredoDeTrocaDeEmail | null = null
  emailsComConta = new Set(['maria@exemplo.com.br', 'joao@exemplo.com.br'])
  trocaFalha = false
  readonly trocados: { novoEmail: string; confirmarEm: number | null }[] = []
  readonly erros: { errosSeguidos: number; bloqueadaAte: number | null }[] = []
  async paraMeusDados(contaId: string): Promise<ContaDosMeusDados | null> {
    return contaId === this.conta.id ? { conta: this.conta, acesso: this.acesso } : null
  }
  async gravarTrocaDeEmail(_: string, troca: SegredoDeTrocaDeEmail) {
    this.troca = troca
    return true
  }
  async paraTrocarEmail(contaId: string): Promise<ContaParaTrocarEmail | null> {
    if (contaId !== this.conta.id) return null
    return { troca: this.troca, ativa: this.conta.ativa, confirmadaEm: this.conta.confirmadaEm }
  }
  async trocarEmail(_: string, novoEmail: string, confirmarEm: number | null) {
    if (this.trocaFalha) return false
    this.trocados.push({ novoEmail, confirmarEm })
    this.emailsComConta.delete(this.conta.email)
    this.emailsComConta.add(novoEmail)
    this.conta = { ...this.conta, email: novoEmail, confirmadaEm: confirmarEm ?? this.conta.confirmadaEm }
    this.troca = null
    return true
  }
  async existeComEmail(email: string) {
    return this.emailsComConta.has(email)
  }
  async apagarConta() {
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

function montar(opcoes: { email?: false } = {}) {
  const cena = {
    agora: TERCA_8H_EM_BELEM,
    contas: new Contas(),
    mandados: [] as MensagemDeEmail[],
    travadas: new Set<string>(),
    limiteDoPedidoPassa: true,
    tarefas: [] as Promise<void>[],
  }
  cena.contas.acesso = { resumoDaSenha: RESUMO, geracao: 0, errosSeguidos: 0 }
  const catalogo: LeitorDoCatalogo = { ler: async () => Promise.reject(new Error('o e-mail não lê o catálogo')) }
  const email: DependenciasDoEmail = {
    contas: cena.contas,
    dados: cena.contas,
    segredos: SEGREDOS,
    limite: { registrar: async () => true },
    /* A trava de verdade: o segundo pedido com a mesma chave, enquanto ela vale, recebe `false`. */
    trava: {
      travar: async (chave) => {
        if (cena.travadas.has(chave)) return false
        cena.travadas.add(chave)
        return true
      },
    },
    limiteDoPedido: { registrar: async () => cena.limiteDoPedidoPassa },
    carteiro: {
      enviar: async (mensagem) => {
        cena.mandados.push(mensagem)
        return true
      },
    },
    sal: 'sal-de-teste',
    novoCodigo: () => CODIGO,
    emSegundoPlano: (tarefa) => void cena.tarefas.push(tarefa),
  }
  const app = criarApp({
    config: CONFIG,
    catalogo,
    envio: null,
    email: opcoes.email === false ? null : email,
    relogio: () => cena.agora,
  })
  const cookie = () =>
    `${NOME_DO_COOKIE}=${valorDaSessao({ contaId: 'conta-1', emitidaEm: cena.agora.getTime(), geracao: 0 }, SEGREDOS)}`
  const post = (caminho: string, corpo: unknown, cabecalhos: Record<string, string> = {}) =>
    app.request(caminho, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGEM, 'x-real-ip': '200.1.2.3', ...cabecalhos },
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    })
  const pedir = (corpo: unknown, cabecalhos: Record<string, string> = { Cookie: cookie() }) =>
    post('/conta/email/trocar', corpo, cabecalhos)
  const confirmar = (corpo: unknown) => post('/conta/email/confirmacao', corpo)
  /** Espera o trabalho que roda depois da resposta. */
  const depois = () => Promise.all(cena.tarefas)
  return { cena, pedir, confirmar, depois }
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

describe('o e-mail mascarado do aviso', () => {
  it.each([
    ['joao.lima@exemplo.com.br', 'j•••a@exemplo.com.br'],
    ['ab@exemplo.com.br', 'a•••@exemplo.com.br'],
    ['a@exemplo.com.br', 'a•••@exemplo.com.br'],
  ])('%s → %s', (email, mascarado) => {
    expect(emailMascarado(email)).toBe(mascarado)
  })
})

describe('POST /conta/email/trocar — o pedido (4.2, B)', () => {
  it('o e-mail livre: 202, o aviso ao antigo, e o link de 24 horas ao novo, que só vale depois de aberto', async () => {
    const { cena, pedir, depois } = montar()
    const resposta = await pedir({ senha: SENHA, novoEmail: ' Maria.Lima@Exemplo.com.br ' })
    expect(resposta.status).toBe(202)
    expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)
    await depois()

    expect(cena.mandados.map((m) => m.para)).toEqual(['maria@exemplo.com.br', 'maria.lima@exemplo.com.br'])
    const [aviso, link] = cena.mandados as [MensagemDeEmail, MensagemDeEmail]
    expect(aviso.texto).toContain('m•••a@exemplo.com.br')
    expect(aviso.texto).not.toContain('maria.lima@')
    expect(link.texto).toContain(`${ORIGEM}/conta/confirmar-email#conta-1.${CODIGO}`)

    expect(cena.contas.troca).toEqual({
      resumoDoCodigo: resumirCodigo(CODIGO),
      valeAte: cena.agora.getTime() + PRAZO_DA_CONFIRMACAO_MS,
      novoEmail: 'maria.lima@exemplo.com.br',
    })
    /* A conta ainda tem o e-mail antigo. */
    expect(cena.contas.conta.email).toBe('maria@exemplo.com.br')
    expect(logs.join('\n')).not.toContain('@exemplo')
  })

  it('o e-mail de outra conta: a mesma resposta; o antigo avisado, o dono do outro avisado, e nenhum link', async () => {
    const { cena, pedir, depois } = montar()
    const resposta = await pedir({ senha: SENHA, novoEmail: 'joao@exemplo.com.br' })
    expect(resposta.status).toBe(202)
    expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)
    await depois()

    expect(cena.mandados.map((m) => m.para)).toEqual(['maria@exemplo.com.br', 'joao@exemplo.com.br'])
    expect(cena.mandados[1]?.texto).toContain('Alguém tentou usar este e-mail numa conta da NAVEG')
    expect(cena.mandados[1]?.texto).not.toContain('confirmar-email')
    expect(cena.contas.troca).toBeNull()
  })

  it('dentro dos 60 segundos, ou passado o teto da hora: a mesma resposta, e nada mandado', async () => {
    const { cena, pedir, depois } = montar()
    await pedir({ senha: SENHA, novoEmail: 'maria.lima@exemplo.com.br' })
    await depois()
    cena.mandados.length = 0

    expect((await pedir({ senha: SENHA, novoEmail: 'outra@exemplo.com.br' })).status).toBe(202)
    await depois()
    expect(cena.mandados).toEqual([])

    cena.travadas.clear()
    cena.limiteDoPedidoPassa = false
    expect((await pedir({ senha: SENHA, novoEmail: 'outra@exemplo.com.br' })).status).toBe(202)
    await depois()
    expect(cena.mandados).toEqual([])
  })

  it('a senha atual errada: 403, o erro conta nas tentativas, e nada mandado', async () => {
    const { cena, pedir } = montar()
    const resposta = await pedir({ senha: 'não é esta', novoEmail: 'maria.lima@exemplo.com.br' })
    expect(resposta.status).toBe(403)
    expect(await resposta.json()).toMatchObject({ erro: 'CREDENCIAIS_INVALIDAS' })
    expect(cena.contas.erros).toEqual([{ errosSeguidos: 1, bloqueadaAte: null }])
    expect(cena.tarefas).toEqual([])
  })

  it.each([
    ['sem a forma de um e-mail', 'maria.lima'],
    ['o mesmo de agora', ' MARIA@exemplo.com.br'],
  ])('o e-mail novo %s: 422 CADASTRO_INVALIDO, com EMAIL', async (_, novoEmail) => {
    const { cena, pedir } = montar()
    const resposta = await pedir({ senha: SENHA, novoEmail })
    expect(resposta.status).toBe(422)
    expect(await resposta.json()).toMatchObject({ erro: 'CADASTRO_INVALIDO', pendencias: ['EMAIL'] })
    expect(cena.tarefas).toEqual([])
  })

  it('sem quem entrou: 401, sem conferir a senha', async () => {
    const { cena, pedir } = montar()
    expect((await pedir({ senha: SENHA, novoEmail: 'maria.lima@exemplo.com.br' }, {})).status).toBe(401)
    expect(cena.contas.erros).toEqual([])
  })

  it.each([
    ['vazio', ''],
    ['sem o e-mail novo', JSON.stringify({ senha: SENHA })],
    ['com o e-mail longo demais', JSON.stringify({ senha: SENHA, novoEmail: `${'a'.repeat(250)}@x.com` })],
  ])('o corpo %s: 400', async (_, corpo) => {
    const { pedir } = montar()
    expect((await pedir(corpo)).status).toBe(400)
  })

  it('sem a troca configurada: 503', async () => {
    const { pedir } = montar({ email: false })
    expect((await pedir({ senha: SENHA, novoEmail: 'maria.lima@exemplo.com.br' })).status).toBe(503)
  })
})

describe('POST /conta/email/confirmacao — o link aberto no e-mail novo', () => {
  /** O pedido feito e o trabalho esperado: o link está guardado. */
  async function comPedido() {
    const m = montar()
    await m.pedir({ senha: SENHA, novoEmail: 'maria.lima@exemplo.com.br' })
    await m.depois()
    return m
  }

  it('troca o e-mail, apaga o pedido, e o link aberto de novo não vale mais', async () => {
    const { cena, confirmar } = await comPedido()
    const resposta = await confirmar({ contaId: 'conta-1', codigo: CODIGO })
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toEqual(EMAIL_TROCADO)
    expect(cena.contas.trocados).toEqual([{ novoEmail: 'maria.lima@exemplo.com.br', confirmarEm: null }])
    expect(logs).toContain('conta conta-1: e-mail trocado')

    expect((await confirmar({ contaId: 'conta-1', codigo: CODIGO })).status).toBe(410)
  })

  it('a conta por confirmar fica confirmada: o link provou o e-mail novo (3.2, E)', async () => {
    const m = montar()
    m.cena.contas.conta = { ...MARIA, confirmadaEm: null }
    await m.pedir({ senha: SENHA, novoEmail: 'maria.lima@exemplo.com.br' })
    await m.depois()
    await m.confirmar({ contaId: 'conta-1', codigo: CODIGO })
    expect(m.cena.contas.trocados).toEqual([
      { novoEmail: 'maria.lima@exemplo.com.br', confirmarEm: m.cena.agora.getTime() },
    ])
  })

  it('o código errado, ou de outra conta: 410 LINK_INVALIDO', async () => {
    const { confirmar } = await comPedido()
    expect(await (await confirmar({ contaId: 'conta-1', codigo: 'x'.repeat(43) })).json()).toMatchObject({
      erro: 'LINK_INVALIDO',
    })
    expect((await confirmar({ contaId: 'conta-2', codigo: CODIGO })).status).toBe(410)
  })

  it('depois das 24 horas: 410 LINK_VENCIDO', async () => {
    const { cena, confirmar } = await comPedido()
    cena.agora = new Date(cena.agora.getTime() + PRAZO_DA_CONFIRMACAO_MS + 1)
    expect(await (await confirmar({ contaId: 'conta-1', codigo: CODIGO })).json()).toMatchObject({
      erro: 'LINK_VENCIDO',
    })
  })

  it('o e-mail ficou de outra conta entre o pedido e o link: 409 EMAIL_EM_USO, e nada trocado', async () => {
    const { cena, confirmar } = await comPedido()
    cena.contas.emailsComConta.add('maria.lima@exemplo.com.br')
    const resposta = await confirmar({ contaId: 'conta-1', codigo: CODIGO })
    expect(resposta.status).toBe(409)
    expect(await resposta.json()).toMatchObject({ erro: 'EMAIL_EM_USO' })
    expect(cena.contas.trocados).toEqual([])
  })

  it('a conta desativada depois do pedido: 403 CONTA_DESATIVADA', async () => {
    const { cena, confirmar } = await comPedido()
    cena.contas.conta = { ...cena.contas.conta, ativa: false }
    expect((await confirmar({ contaId: 'conta-1', codigo: CODIGO })).status).toBe(403)
  })

  it('o banco recusa: 500', async () => {
    const { cena, confirmar } = await comPedido()
    cena.contas.trocaFalha = true
    expect((await confirmar({ contaId: 'conta-1', codigo: CODIGO })).status).toBe(500)
  })

  it('o corpo sem o código: 400', async () => {
    const { confirmar } = montar()
    expect((await confirmar({ contaId: 'conta-1' })).status).toBe(400)
  })
})
