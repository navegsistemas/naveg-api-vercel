/**
 * **Trocar a senha em Meus dados** (o PR 9b da #30), com portas falsas e o scrypt de verdade.
 *
 * O relógio começa numa terça, 13/10/2026, 08:00 em Belém. O principal: **a senha atual é a prova** — sem ela, quem
 * pega o celular com a conta aberta não troca a senha, e o erro dela conta nas tentativas de entrar (3.3, C). Aceita,
 * a conta sai dos outros aparelhos, fica dentro neste, e o aviso sai (4.2, C).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataCalendario, type ContaDoCliente } from '@navegsistemas/domain'

import { criarApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { conferirSenha, resumirSenha } from '../src/conta/senha.js'
import { lerSessao, NOME_DO_COOKIE, valorDaSessao } from '../src/conta/sessao.js'
import type {
  ContaDosMeusDados,
  ContasDoCliente,
  DadosDaConta,
  LeitorDoCatalogo,
  MensagemDeEmail,
  SegredoDeAcesso,
  TrocaDeSenha,
} from '../src/portas.js'
import type { DependenciasDaSenha } from '../src/rotas/senha.js'
import { dentro, ESPERA_DAS_TENTATIVAS_MS } from '../src/rotas/sessao.js'

const ORIGEM = 'https://agencia.naveg.com.br'
const TERCA_8H_EM_BELEM = new Date('2026-10-13T11:00:00Z')
const SENHA = 'rio e maré cheia'
const NOVA = 'a balsa sai às sete'
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
  documento: null,
  criadaEm: 1_792_000_000_000,
  confirmadaEm: 1_792_000_100_000,
  ativa: true,
  ultimoEnvio: null,
  bloqueadaAte: null,
  envioPorEmail: null,
  envioPorWhatsapp: null,
}

/** A conta da Maria, em memória: o que Meus dados lê, e o que a troca e o erro de senha gravam. */
class Contas implements ContasDoCliente, DadosDaConta {
  conta: ContaDoCliente = MARIA
  acesso!: SegredoDeAcesso
  trocaFalha = false
  readonly trocas: TrocaDeSenha[] = []
  readonly erros: { errosSeguidos: number; bloqueadaAte: number | null }[] = []
  async paraMeusDados(contaId: string): Promise<ContaDosMeusDados | null> {
    return contaId === this.conta.id ? { conta: this.conta, acesso: this.acesso } : null
  }
  async salvarDados() {
    return true
  }
  async registrarErroDeSenha(_: string, errosSeguidos: number, bloqueadaAte: number | null) {
    this.erros.push({ errosSeguidos, bloqueadaAte })
    this.acesso = { ...this.acesso, errosSeguidos }
    if (bloqueadaAte !== null) this.conta = { ...this.conta, bloqueadaAte }
    return true
  }
  async trocarSenha(_: string, troca: TrocaDeSenha) {
    if (this.trocaFalha) return false
    this.trocas.push(troca)
    this.acesso = { resumoDaSenha: troca.resumoDaSenha, geracao: troca.geracao, errosSeguidos: 0 }
    if (troca.tirarBloqueio) this.conta = { ...this.conta, bloqueadaAte: null }
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

function montar(opcoes: { semDados?: true } = {}) {
  const cena = {
    agora: TERCA_8H_EM_BELEM,
    contas: new Contas(),
    mandados: [] as MensagemDeEmail[],
    ipsNoLimite: [] as string[],
    limitePassa: true,
    senhaVazada: false,
    tarefas: [] as Promise<void>[],
  }
  cena.contas.acesso = { resumoDaSenha: RESUMO, geracao: 2, errosSeguidos: 0 }
  const catalogo: LeitorDoCatalogo = { ler: async () => Promise.reject(new Error('a senha não lê o catálogo')) }
  const senha: DependenciasDaSenha = {
    contas: cena.contas,
    limite: {
      registrar: async (ip) => {
        cena.ipsNoLimite.push(ip)
        return cena.limitePassa
      },
    },
    trava: { travar: async () => true },
    limiteDoPedido: { registrar: async () => true },
    senhaVazada: { vazada: async () => cena.senhaVazada },
    carteiro: {
      enviar: async (mensagem) => {
        cena.mandados.push(mensagem)
        return true
      },
    },
    segredos: SEGREDOS,
    sal: 'sal-de-teste',
    emSegundoPlano: (tarefa) => void cena.tarefas.push(tarefa),
    ...(opcoes.semDados === true ? {} : { dados: cena.contas }),
  }
  const app = criarApp({ config: CONFIG, catalogo, envio: null, senha, relogio: () => cena.agora })
  /** O cookie da Maria, emitido agora, com a geração dada. */
  const cookie = (geracao = 2) =>
    `${NOME_DO_COOKIE}=${valorDaSessao({ contaId: 'conta-1', emitidaEm: cena.agora.getTime(), geracao }, SEGREDOS)}`
  const trocar = (corpo: unknown, cabecalhos: Record<string, string> = {}) =>
    app.request('/conta/senha/trocar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGEM, 'x-real-ip': '200.1.2.3', ...cabecalhos },
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    })
  return { cena, cookie, trocar }
}

/** O valor do cookie de uma resposta. */
function valorDoCookie(resposta: Response): string {
  const cabecalho = resposta.headers.get('set-cookie') as string
  return (cabecalho.split(';')[0] as string).slice(`${NOME_DO_COOKIE}=`.length)
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

describe('POST /conta/senha/trocar — com a senha atual (4.2, C)', () => {
  it('troca, soma a geração (sai dos outros aparelhos), fica dentro neste e manda o aviso', async () => {
    const { cena, cookie, trocar } = montar()
    const resposta = await trocar({ atual: SENHA, nova: NOVA }, { Cookie: cookie() })
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toEqual(dentro(true))

    const [troca] = cena.contas.trocas
    expect(troca).toMatchObject({ geracao: 3, confirmarEm: null, tirarBloqueio: false })
    expect(await conferirSenha(NOVA, troca?.resumoDaSenha as string)).toBe(true)

    /* O cookie novo leva a geração nova; o antigo, de geração 2, não vale mais em lugar nenhum. */
    expect(lerSessao(valorDoCookie(resposta), SEGREDOS, cena.agora.getTime())).toMatchObject({ geracao: 3 })

    await Promise.all(cena.tarefas)
    expect(cena.mandados).toHaveLength(1)
    expect(cena.mandados[0]).toMatchObject({ para: 'maria@exemplo.com.br', assunto: expect.stringContaining('senha') })
    expect(logs).toContain('conta conta-1: senha trocada em Meus dados')
    expect(logs.join('\n')).not.toContain(SENHA)
    expect(logs.join('\n')).not.toContain(NOVA)
  })

  it('o cookie antigo, depois da troca, recebe 401', async () => {
    const { cookie, trocar } = montar()
    const antigo = cookie()
    await trocar({ atual: SENHA, nova: NOVA }, { Cookie: antigo })
    expect((await trocar({ atual: NOVA, nova: 'outra senha qualquer' }, { Cookie: antigo })).status).toBe(401)
  })

  it('a conta por confirmar continua por confirmar: a troca aqui não prova o e-mail', async () => {
    const { cena, cookie, trocar } = montar()
    cena.contas.conta = { ...MARIA, confirmadaEm: null }
    const resposta = await trocar({ atual: SENHA, nova: NOVA }, { Cookie: cookie() })
    expect(await resposta.json()).toEqual(dentro(false))
    expect(cena.contas.trocas[0]?.confirmarEm).toBeNull()
  })

  it('a senha atual errada: 403, e o erro conta nas tentativas', async () => {
    const { cena, cookie, trocar } = montar()
    const resposta = await trocar({ atual: 'não é esta', nova: NOVA }, { Cookie: cookie() })
    expect(resposta.status).toBe(403)
    expect(await resposta.json()).toMatchObject({ erro: 'CREDENCIAIS_INVALIDAS' })
    expect(cena.contas.erros).toEqual([{ errosSeguidos: 1, bloqueadaAte: null }])
    expect(cena.contas.trocas).toEqual([])
  })

  it('o quinto erro seguido espera 15 minutos, e nem a senha certa troca enquanto espera (3.3, C)', async () => {
    const { cena, cookie, trocar } = montar()
    cena.contas.acesso = { ...cena.contas.acesso, errosSeguidos: 4 }
    const quinto = await trocar({ atual: 'não é esta', nova: NOVA }, { Cookie: cookie() })
    expect(quinto.status).toBe(429)
    expect(await quinto.json()).toMatchObject({ erro: 'TENTATIVAS_DEMAIS' })
    expect(cena.contas.erros.at(-1)).toEqual({
      errosSeguidos: 0,
      bloqueadaAte: cena.agora.getTime() + ESPERA_DAS_TENTATIVAS_MS,
    })

    expect((await trocar({ atual: SENHA, nova: NOVA }, { Cookie: cookie() })).status).toBe(429)
    expect(cena.contas.trocas).toEqual([])
  })

  it('passada a espera, a senha certa troca e tira o bloqueio', async () => {
    const { cena, cookie, trocar } = montar()
    cena.contas.conta = { ...MARIA, bloqueadaAte: cena.agora.getTime() - 1 }
    expect((await trocar({ atual: SENHA, nova: NOVA }, { Cookie: cookie() })).status).toBe(200)
    expect(cena.contas.trocas[0]?.tirarBloqueio).toBe(true)
  })

  it.each([
    ['curta', 'curta', 'SENHA_CURTA', false],
    ['comum', '12345678', 'SENHA_COMUM', false],
    ['vazada', 'uma senha que vazou', 'SENHA_VAZADA', true],
  ])('a senha nova %s: 422 SENHA_FRACA, e nada trocado', async (_, nova, motivo, vazada) => {
    const { cena, cookie, trocar } = montar()
    cena.senhaVazada = vazada
    const resposta = await trocar({ atual: SENHA, nova }, { Cookie: cookie() })
    expect(resposta.status).toBe(422)
    expect(await resposta.json()).toMatchObject({ erro: 'SENHA_FRACA', pendencias: [motivo] })
    expect(cena.contas.trocas).toEqual([])
  })

  it('sem quem entrou: 401, sem conferir a senha', async () => {
    const { cena, trocar } = montar()
    expect((await trocar({ atual: SENHA, nova: NOVA })).status).toBe(401)
    expect(cena.contas.erros).toEqual([])
  })

  it('de outra origem: 403 ORIGEM_NAO_PERMITIDA, antes de tudo', async () => {
    const { cena, cookie, trocar } = montar()
    const resposta = await trocar({ atual: SENHA, nova: NOVA }, { Cookie: cookie(), Origin: 'https://outro.site' })
    expect(await resposta.json()).toMatchObject({ erro: 'ORIGEM_NAO_PERMITIDA' })
    expect(cena.ipsNoLimite).toEqual([])
  })

  it('endereço com pedidos demais: 429 LIMITE_EXCEDIDO', async () => {
    const { cena, cookie, trocar } = montar()
    cena.limitePassa = false
    const resposta = await trocar({ atual: SENHA, nova: NOVA }, { Cookie: cookie() })
    expect(await resposta.json()).toMatchObject({ erro: 'LIMITE_EXCEDIDO' })
  })

  it.each([
    ['vazio', ''],
    ['sem a nova', JSON.stringify({ atual: SENHA })],
    ['com a senha longa demais', JSON.stringify({ atual: SENHA, nova: 'a'.repeat(129) })],
  ])('o corpo %s: 400', async (_, corpo) => {
    const { cookie, trocar } = montar()
    expect((await trocar(corpo, { Cookie: cookie() })).status).toBe(400)
  })

  it('o banco recusa: 500, e nem cookie novo nem aviso', async () => {
    const { cena, cookie, trocar } = montar()
    cena.contas.trocaFalha = true
    const resposta = await trocar({ atual: SENHA, nova: NOVA }, { Cookie: cookie() })
    expect(resposta.status).toBe(500)
    expect(resposta.headers.get('set-cookie')).toBeNull()
    expect(cena.tarefas).toEqual([])
  })

  it('sem a conta de Meus dados ligada: 503 SENHA_INDISPONIVEL', async () => {
    const { cookie, trocar } = montar({ semDados: true })
    const resposta = await trocar({ atual: SENHA, nova: NOVA }, { Cookie: cookie() })
    expect(resposta.status).toBe(503)
    expect(await resposta.json()).toMatchObject({ erro: 'SENHA_INDISPONIVEL' })
  })
})
