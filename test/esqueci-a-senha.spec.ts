/**
 * **Esqueci a senha** (o PR 8 da #30), com portas falsas e o scrypt de verdade.
 *
 * O relógio está numa terça, 13/10/2026, 08:00 em Belém, e anda quando o cenário pede. O principal: **o pedido não
 * revela quem tem conta** (3.4, B), o link vale 1 hora e uma vez só (A), e quem troca fica dentro neste aparelho e
 * sai dos outros (C).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TipoDeLink } from '@navegsistemas/domain'

import { criarApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { PRAZO_DA_TROCA_MS, resumirCodigo } from '../src/conta/codigo.js'
import { conferirSenha } from '../src/conta/senha.js'
import { lerSessao } from '../src/conta/sessao.js'
import type {
  ContaDaSessao,
  ContaParaEntrar,
  ContaParaLink,
  ContaParaTrocarSenha,
  ContasDoCliente,
  LeitorDoCatalogo,
  MensagemDeEmail,
  SegredoDeTroca,
  TrocaDeSenha,
} from '../src/portas.js'
import { CONFIRA_O_EMAIL } from '../src/rotas/conta.js'
import type { DependenciasDaSenha } from '../src/rotas/senha.js'
import { dentro } from '../src/rotas/sessao.js'

const ORIGEM = 'https://agencia.naveg.com.br'
const TERCA_8H_EM_BELEM = new Date('2026-10-13T11:00:00Z')
const SEGREDOS = { atual: 's'.repeat(43), anterior: null }
const CODIGO = 'c'.repeat(43)
const SENHA_NOVA = 'barco no porto do grego'
const MARIA = { email: ' Maria@Exemplo.com.br ' }

const CONFIG: Config = {
  projetoFirebase: 'fluviapp-teste',
  contaDeLeitura: '{}',
  contaDeEscrita: '{}',
  chaveWebDoFirebase: null,
  empresaId: 'empresa-naveg',
  origensPermitidas: [ORIGEM],
  protecaoDoEnvio: null,
}

type ContaDaMaria = ContaParaLink & {
  email: string
  confirmadaEm: number | null
  bloqueadaAte: number | null
  geracao: number
}

/** A conta da Maria, em memória: o que o pedido e a senha nova leem e gravam. */
class Contas implements ContasDoCliente {
  conta: ContaDaMaria = {
    contaId: 'conta-1',
    nome: 'Maria Souza',
    email: 'maria@exemplo.com.br',
    confirmada: true,
    confirmadaEm: 1_792_000_000_000,
    ativa: true,
    bloqueadaAte: null,
    geracao: 3,
  }
  troca: SegredoDeTroca | null = null
  readonly senhasTrocadas: { contaId: string; troca: TrocaDeSenha }[] = []
  readonly envios: { contaId: string; tipo: TipoDeLink; em: number }[] = []
  falhar = false

  async paraMandarLink(email: string) {
    if (email !== this.conta.email) return null
    const { contaId, nome, ativa } = this.conta
    return { contaId, nome, ativa, confirmada: this.conta.confirmadaEm !== null }
  }
  async gravarTrocaDeSenha(_: string, troca: SegredoDeTroca) {
    if (this.falhar) return false
    this.troca = troca
    return true
  }
  async paraTrocarSenha(contaId: string): Promise<ContaParaTrocarSenha | null> {
    if (contaId !== this.conta.contaId) return null
    const { ativa, confirmadaEm, bloqueadaAte, geracao, nome, email } = this.conta
    return { troca: this.troca, ativa, confirmadaEm, bloqueadaAte, geracao, nome, email }
  }
  async trocarSenha(contaId: string, troca: TrocaDeSenha) {
    if (this.falhar) return false
    this.senhasTrocadas.push({ contaId, troca })
    this.troca = null
    this.conta = {
      ...this.conta,
      geracao: troca.geracao,
      confirmadaEm: troca.confirmarEm ?? this.conta.confirmadaEm,
      bloqueadaAte: troca.tirarBloqueio ? null : this.conta.bloqueadaAte,
    }
    return true
  }
  async registrarEnvio(contaId: string, tipo: TipoDeLink, em: number) {
    this.envios.push({ contaId, tipo, em })
  }
  /* O que a troca de senha não usa. */
  async existeComEmail() {
    return false
  }
  async criar() {
    return true
  }
  async paraConfirmar() {
    return null
  }
  async confirmar() {
    return true
  }
  async trocarConfirmacao() {
    return true
  }
  async paraEntrar(): Promise<ContaParaEntrar | null> {
    return null
  }
  async registrarErroDeSenha() {
    return true
  }
  async registrarEntrada() {
    return true
  }
  async paraSessao(): Promise<ContaDaSessao | null> {
    return null
  }
}

function montar(opcoes: { senha?: false } = {}) {
  const cena = {
    agora: TERCA_8H_EM_BELEM,
    contas: new Contas(),
    mandados: [] as MensagemDeEmail[],
    saem: true,
    ipsNoLimite: [] as string[],
    travas: [] as string[],
    pedidosNoLimite: [] as string[],
    limitePassa: true,
    travaPassa: true,
    limiteDoPedidoPassa: true,
    senhaVazada: false,
    tarefas: [] as Promise<void>[],
  }
  const catalogo: LeitorDoCatalogo = { ler: async () => Promise.reject(new Error('a senha não lê o catálogo')) }
  const senha: DependenciasDaSenha | null =
    opcoes.senha === false
      ? null
      : {
          contas: cena.contas,
          limite: {
            registrar: async (ip) => {
              cena.ipsNoLimite.push(ip)
              return cena.limitePassa
            },
          },
          trava: {
            travar: async (chave) => {
              cena.travas.push(chave)
              return cena.travaPassa
            },
          },
          limiteDoPedido: {
            registrar: async (chave) => {
              cena.pedidosNoLimite.push(chave)
              return cena.limiteDoPedidoPassa
            },
          },
          senhaVazada: { vazada: async () => cena.senhaVazada },
          carteiro: {
            enviar: async (mensagem) => {
              if (!cena.saem) return false
              cena.mandados.push(mensagem)
              return true
            },
          },
          segredos: SEGREDOS,
          sal: 'sal-de-teste',
          novoCodigo: () => CODIGO,
          emSegundoPlano: (tarefa) => void cena.tarefas.push(tarefa),
        }
  const app = criarApp({ config: CONFIG, catalogo, envio: null, senha, relogio: () => cena.agora })
  const postar = (caminho: string) => async (corpo: unknown, cabecalhos: Record<string, string> = {}) => {
    const resposta = await app.request(caminho, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGEM, 'x-real-ip': '200.1.2.3', ...cabecalhos },
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    })
    /* O que ficou para depois da resposta. */
    await Promise.all(cena.tarefas.splice(0))
    return resposta
  }
  return { cena, pedir: postar('/conta/senha/esqueci'), trocar: postar('/conta/senha/nova') }
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

describe('POST /conta/senha/esqueci (3.4, A, B e F)', () => {
  it('o link de 1 hora, mandado à Maria, e o envio espelhado para o painel', async () => {
    const { cena, pedir } = montar()
    const resposta = await pedir(MARIA)
    expect(resposta.status).toBe(202)
    expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)
    expect(cena.contas.troca).toEqual({
      resumoDoCodigo: resumirCodigo(CODIGO),
      valeAte: TERCA_8H_EM_BELEM.getTime() + PRAZO_DA_TROCA_MS,
    })
    const [mandado] = cena.mandados
    expect(mandado?.para).toBe('maria@exemplo.com.br')
    expect(mandado?.assunto).toBe('Troque sua senha na NAVEG')
    expect(mandado?.texto).toContain(`${ORIGEM}/conta/nova-senha#conta-1.${CODIGO}`)
    expect(mandado?.texto).toContain('1 hora, e uma vez só')
    expect(cena.contas.envios).toEqual([{ contaId: 'conta-1', tipo: 'TROCA_DE_SENHA', em: TERCA_8H_EM_BELEM.getTime() }])
    expect(logs.join('\n')).not.toContain('maria@')
  })

  it('a conta por confirmar também recebe o link (3.4, E)', async () => {
    const { cena, pedir } = montar()
    cena.contas.conta = { ...cena.contas.conta, confirmada: false, confirmadaEm: null }
    await pedir(MARIA)
    expect(cena.mandados).toHaveLength(1)
  })

  it('a conta desativada recebe o aviso, com o WhatsApp, e nenhum link (3.4, F); a resposta é a mesma', async () => {
    const { cena, pedir } = montar()
    cena.contas.conta = { ...cena.contas.conta, ativa: false }
    const resposta = await pedir(MARIA)
    expect(resposta.status).toBe(202)
    expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)
    expect(cena.contas.troca).toBeNull()
    const [aviso] = cena.mandados
    expect(aviso?.assunto).toBe('Sua conta na NAVEG está desativada')
    expect(aviso?.texto).toContain('(91) 99203-5322')
    expect(aviso?.texto).not.toContain('/conta/nova-senha')
  })

  it('o e-mail sem conta e o e-mail sem forma: a mesma resposta, sem mandar nada', async () => {
    const { cena, pedir } = montar()
    for (const email of ['ninguem@exemplo.com.br', 'não é e-mail']) {
      const resposta = await pedir({ email })
      expect(resposta.status).toBe(202)
      expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)
    }
    expect(cena.mandados).toHaveLength(0)
    expect(logs.join('\n')).toContain('troca de senha pedida para e-mail sem conta: nada mandado')
  })

  it('os freios: dentro dos 60 segundos nada sai, nem gasta a hora; passou dos 5 na hora, nada sai', async () => {
    const minuto = montar()
    minuto.cena.travaPassa = false
    expect((await minuto.pedir(MARIA)).status).toBe(202)
    expect(minuto.cena.travas.at(-1)).toMatch(/^troca:/)
    expect(minuto.cena.pedidosNoLimite).toHaveLength(0)
    expect(minuto.cena.mandados).toHaveLength(0)

    const hora = montar()
    hora.cena.limiteDoPedidoPassa = false
    expect((await hora.pedir(MARIA)).status).toBe(202)
    expect(hora.cena.mandados).toHaveLength(0)
    expect(hora.cena.contas.troca).toBeNull()
  })

  it('o link que o banco recusa não é mandado; o e-mail que não sai fica no log', async () => {
    const recusado = montar()
    recusado.cena.contas.falhar = true
    expect((await recusado.pedir(MARIA)).status).toBe(202)
    expect(recusado.cena.mandados).toHaveLength(0)

    const semCorreio = montar()
    semCorreio.cena.saem = false
    expect((await semCorreio.pedir(MARIA)).status).toBe(202)
    expect(semCorreio.cena.contas.envios).toHaveLength(0)
    expect(logs.join('\n')).toContain('conta conta-1: o link de troca de senha não saiu')
  })

  it('o corpo sem e-mail: 400, sem gastar o limite; a origem de fora: 403; desligado: 503; o limite por IP: 429', async () => {
    const { cena, pedir } = montar()
    expect((await pedir('{ não é json')).status).toBe(400)
    expect((await pedir({})).status).toBe(400)
    expect(cena.ipsNoLimite).toHaveLength(0)
    expect((await pedir(MARIA, { Origin: 'https://outro.site' })).status).toBe(403)
    cena.limitePassa = false
    expect((await pedir(MARIA)).status).toBe(429)
    expect(cena.mandados).toHaveLength(0)

    const desligado = montar({ senha: false })
    const resposta = await desligado.pedir(MARIA)
    expect(resposta.status).toBe(503)
    expect(await resposta.json()).toMatchObject({ erro: 'SENHA_INDISPONIVEL' })
  })
})

describe('POST /conta/senha/nova (3.4, A, C, D e E)', () => {
  /** A Maria pediu o link; o e-mail dele já saiu. */
  async function comLink() {
    const montado = montar()
    await montado.pedir(MARIA)
    montado.cena.mandados.length = 0
    return montado
  }

  it('a senha nova: o resumo, a geração somada, dentro neste aparelho, e o aviso da troca com a hora', async () => {
    const { cena, trocar } = await comLink()
    cena.agora = new Date(TERCA_8H_EM_BELEM.getTime() + 10 * 60 * 1000)
    const resposta = await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: SENHA_NOVA })
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toEqual(dentro(true))

    const [trocada] = cena.contas.senhasTrocadas
    expect(trocada?.troca).toMatchObject({ geracao: 4, confirmarEm: null, tirarBloqueio: false })
    expect(await conferirSenha(SENHA_NOVA, trocada?.troca.resumoDaSenha as string)).toBe(true)

    /* Dentro com a geração nova: o cookie de antes (geração 3) não vale mais. */
    const cookie = resposta.headers.get('set-cookie') as string
    const valor = cookie.split(';')[0]?.slice('__Host-sessao='.length) as string
    expect(lerSessao(valor, SEGREDOS, cena.agora.getTime())).toEqual({
      contaId: 'conta-1',
      emitidaEm: cena.agora.getTime(),
      geracao: 4,
    })

    const [aviso] = cena.mandados
    expect(aviso?.para).toBe('maria@exemplo.com.br')
    expect(aviso?.assunto).toBe('Sua senha foi trocada')
    expect(aviso?.texto).toContain('13/10/2026, 08:10')
    expect(aviso?.texto).toContain('(91) 99203-5322')
    expect(logs.join('\n')).toContain('conta conta-1: senha trocada')
  })

  it('vale uma vez só: o mesmo link de novo dá 410 LINK_INVALIDO', async () => {
    const { trocar } = await comLink()
    expect((await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: SENHA_NOVA })).status).toBe(200)
    const segunda = await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: 'outra senha qualquer' })
    expect(segunda.status).toBe(410)
    expect(await segunda.json()).toMatchObject({ erro: 'LINK_INVALIDO' })
  })

  it('a conta por confirmar fica confirmada (3.4, E), e o bloqueio das tentativas sai', async () => {
    const { cena, trocar } = await comLink()
    cena.contas.conta = {
      ...cena.contas.conta,
      confirmadaEm: null,
      bloqueadaAte: TERCA_8H_EM_BELEM.getTime() + 10 * 60 * 1000,
    }
    expect((await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: SENHA_NOVA })).status).toBe(200)
    expect(cena.contas.senhasTrocadas[0]?.troca).toMatchObject({
      confirmarEm: TERCA_8H_EM_BELEM.getTime(),
      tirarBloqueio: true,
    })
    expect(logs.join('\n')).toContain('senha trocada, e o e-mail confirmado')
  })

  it('no último milissegundo da hora ainda vale; um depois, 410 LINK_VENCIDO', async () => {
    const vale = await comLink()
    vale.cena.agora = new Date(TERCA_8H_EM_BELEM.getTime() + PRAZO_DA_TROCA_MS)
    expect((await vale.trocar({ contaId: 'conta-1', codigo: CODIGO, senha: SENHA_NOVA })).status).toBe(200)

    const venceu = await comLink()
    venceu.cena.agora = new Date(TERCA_8H_EM_BELEM.getTime() + PRAZO_DA_TROCA_MS + 1)
    const resposta = await venceu.trocar({ contaId: 'conta-1', codigo: CODIGO, senha: SENHA_NOVA })
    expect(resposta.status).toBe(410)
    expect(await resposta.json()).toMatchObject({ erro: 'LINK_VENCIDO' })
    expect(venceu.cena.contas.senhasTrocadas).toHaveLength(0)
  })

  it('o código errado, a conta que não existe, e o link nunca pedido: 410 LINK_INVALIDO', async () => {
    const { trocar } = await comLink()
    expect((await trocar({ contaId: 'conta-1', codigo: 'd'.repeat(43), senha: SENHA_NOVA })).status).toBe(410)
    expect((await trocar({ contaId: 'conta-2', codigo: CODIGO, senha: SENHA_NOVA })).status).toBe(410)
    const semPedido = montar()
    expect((await semPedido.trocar({ contaId: 'conta-1', codigo: CODIGO, senha: SENHA_NOVA })).status).toBe(410)
  })

  it('desativada depois de pedir: 403 CONTA_DESATIVADA, e a senha continua', async () => {
    const { cena, trocar } = await comLink()
    cena.contas.conta = { ...cena.contas.conta, ativa: false }
    const resposta = await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: SENHA_NOVA })
    expect(resposta.status).toBe(403)
    expect(await resposta.json()).toMatchObject({ erro: 'CONTA_DESATIVADA' })
    expect(cena.contas.senhasTrocadas).toHaveLength(0)
  })

  it('a senha curta, a comum e a vazada: 422 SENHA_FRACA, com o motivo, e o link continua valendo', async () => {
    const { cena, trocar } = await comLink()
    const curta = await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: 'curta' })
    expect(curta.status).toBe(422)
    expect(await curta.json()).toMatchObject({ erro: 'SENHA_FRACA', pendencias: ['SENHA_CURTA'] })
    const comum = await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: 'senha123' })
    expect(await comum.json()).toMatchObject({ erro: 'SENHA_FRACA', pendencias: ['SENHA_COMUM'] })
    cena.senhaVazada = true
    const vazada = await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: SENHA_NOVA })
    expect(await vazada.json()).toMatchObject({ erro: 'SENHA_FRACA', pendencias: ['SENHA_VAZADA'] })
    expect(cena.contas.senhasTrocadas).toHaveLength(0)
    cena.senhaVazada = false
    expect((await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: SENHA_NOVA })).status).toBe(200)
  })

  it('o aviso que não sai fica no log, e a troca vale do mesmo jeito', async () => {
    const { cena, trocar } = await comLink()
    cena.saem = false
    expect((await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: SENHA_NOVA })).status).toBe(200)
    expect(cena.contas.senhasTrocadas).toHaveLength(1)
    expect(logs.join('\n')).toContain('conta conta-1: o aviso da troca de senha não saiu')
  })

  it('o corpo sem a forma: 400; o limite por IP: 429; o banco que recusa: 500 sem detalhe', async () => {
    const { cena, trocar } = await comLink()
    expect((await trocar({ contaId: 'conta-1', codigo: CODIGO })).status).toBe(400)
    expect((await trocar({ contaId: 'conta/1', codigo: CODIGO, senha: SENHA_NOVA })).status).toBe(400)
    expect((await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: 'x'.repeat(129) })).status).toBe(400)
    cena.limitePassa = false
    expect((await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: SENHA_NOVA })).status).toBe(429)
    cena.limitePassa = true
    cena.contas.falhar = true
    const resposta = await trocar({ contaId: 'conta-1', codigo: CODIGO, senha: SENHA_NOVA })
    expect(resposta.status).toBe(500)
    expect(await resposta.json()).toEqual({ erro: 'FALHA_INTERNA', mensagem: 'Falha interna' })
  })
})
