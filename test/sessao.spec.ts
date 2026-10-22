/**
 * **Entrar, sair e a sessão** (o PR 7 da #30), com portas falsas e o scrypt de verdade.
 *
 * O relógio começa numa terça, 13/10/2026, 08:00 em Belém, e anda quando o cenário pede. O principal: **a resposta não
 * revela quem tem conta** — o e-mail sem conta e a senha errada recebem o mesmo `401`, e a quinta tentativa espera nos
 * dois casos (3.3, B e C).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { criarApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { resumirSenha } from '../src/conta/senha.js'
import {
  DURACAO_DA_SESSAO_MS,
  lerSessao,
  NOME_DO_COOKIE,
  RENOVAR_DEPOIS_DE_MS,
  valorDaSessao,
} from '../src/conta/sessao.js'
import type {
  ContaDaSessao,
  ContaParaEntrar,
  ContasDoCliente,
  LeitorDoCatalogo,
  LimitePorIp,
  VerificadorDoDesafio,
} from '../src/portas.js'
import { ERROS_ATE_ESPERAR, ESPERA_DAS_TENTATIVAS_MS, dentro, type DependenciasDoEntrar } from '../src/rotas/sessao.js'

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

/** A conta da Maria, em memória, com o que entrar lê e grava. */
class Contas implements ContasDoCliente {
  conta: ContaParaEntrar | null = null
  readonly erros: { errosSeguidos: number; bloqueadaAte: number | null }[] = []
  readonly entradas: boolean[] = []
  readonly procuras: string[] = []
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
  async paraEntrar(email: string) {
    this.procuras.push(email)
    return email === 'maria@exemplo.com.br' ? this.conta : null
  }
  async registrarErroDeSenha(_: string, errosSeguidos: number, bloqueadaAte: number | null) {
    this.erros.push({ errosSeguidos, bloqueadaAte })
    if (this.conta !== null) {
      this.conta = {
        ...this.conta,
        acesso: { ...this.conta.acesso, errosSeguidos },
        bloqueadaAte: bloqueadaAte ?? this.conta.bloqueadaAte,
      }
    }
    return true
  }
  async registrarEntrada(_: string, tinhaBloqueio: boolean) {
    this.entradas.push(tinhaBloqueio)
    if (this.conta !== null) {
      this.conta = { ...this.conta, acesso: { ...this.conta.acesso, errosSeguidos: 0 }, bloqueadaAte: null }
    }
    return true
  }
  async paraSessao(contaId: string): Promise<ContaDaSessao | null> {
    if (this.conta === null || contaId !== this.conta.contaId) return null
    return { ativa: this.conta.ativa, confirmada: this.conta.confirmada, geracao: this.conta.acesso.geracao }
  }
}

function montar(opcoes: { entrar?: false } = {}) {
  const cena = {
    agora: TERCA_8H_EM_BELEM,
    contas: new Contas(),
    desafios: [] as string[],
    ipsNoLimite: [] as string[],
    emailsNoLimite: [] as string[],
    desafioPassa: true,
    limitePassa: true,
  }
  cena.contas.conta = {
    contaId: 'conta-1',
    ativa: true,
    confirmada: true,
    bloqueadaAte: null,
    acesso: { resumoDaSenha: RESUMO, geracao: 0, errosSeguidos: 0 },
  }
  const catalogo: LeitorDoCatalogo = { ler: async () => Promise.reject(new Error('entrar não lê o catálogo')) }
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
  /* O contador do e-mail sem conta, com o teto da configuração: a quinta tentativa espera. */
  const limiteDoEmail: LimitePorIp = {
    registrar: async (chave) => {
      cena.emailsNoLimite.push(chave)
      return cena.emailsNoLimite.filter((c) => c === chave).length <= ERROS_ATE_ESPERAR - 1
    },
  }
  const entrar: DependenciasDoEntrar | null =
    opcoes.entrar === false
      ? null
      : { contas: cena.contas, desafio, limite, limiteDoEmail, segredos: SEGREDOS, sal: 'sal-de-teste' }
  const app = criarApp({ config: CONFIG, catalogo, envio: null, entrar, relogio: () => cena.agora })

  const entrarCom = (corpo: unknown, cabecalhos: Record<string, string> = {}) =>
    app.request('/conta/entrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGEM, 'x-real-ip': '200.1.2.3', ...cabecalhos },
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    })
  const sessao = (cookie?: string) =>
    app.request('/conta/sessao', { headers: cookie === undefined ? {} : { Cookie: `${NOME_DO_COOKIE}=${cookie}` } })
  const sair = (origem = ORIGEM) => app.request('/conta/sair', { method: 'POST', headers: { Origin: origem } })
  return { cena, entrarCom, sessao, sair }
}

const PEDIDO = { email: ' Maria@Exemplo.com.br ', senha: SENHA, desafio: 'token-bom' }

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
  vi.spyOn(console, 'warn').mockImplementation(guardar)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('o cookie da sessão (ADR-0003, seção 1)', () => {
  const agora = TERCA_8H_EM_BELEM.getTime()
  const sessao = { contaId: 'conta-1', emitidaEm: agora, geracao: 2 }

  it('o que a API assina, ela lê de volta', () => {
    expect(lerSessao(valorDaSessao(sessao, SEGREDOS), SEGREDOS, agora)).toEqual(sessao)
  })

  it('quem muda um número perde a assinatura: a geração, a conta ou o prazo', () => {
    const valor = valorDaSessao(sessao, SEGREDOS)
    expect(lerSessao(valor.replace('.2.', '.3.'), SEGREDOS, agora)).toBeNull()
    expect(lerSessao(valor.replace('conta-1', 'conta-2'), SEGREDOS, agora)).toBeNull()
    expect(lerSessao(valor.replace(String(agora), String(agora + 1)), SEGREDOS, agora)).toBeNull()
    expect(lerSessao('v1.conta-1.1.2', SEGREDOS, agora)).toBeNull()
    expect(lerSessao('v2' + valor.slice(2), SEGREDOS, agora)).toBeNull()
  })

  it('o segredo anterior ainda confere, durante a troca; outro segredo, não', () => {
    const antigo = valorDaSessao(sessao, { atual: 'a'.repeat(43), anterior: null })
    expect(lerSessao(antigo, { atual: 'b'.repeat(43), anterior: 'a'.repeat(43) }, agora)).toEqual(sessao)
    expect(lerSessao(antigo, { atual: 'b'.repeat(43), anterior: null }, agora)).toBeNull()
  })

  it('vale 14 dias, e nem um milissegundo a mais', () => {
    const valor = valorDaSessao(sessao, SEGREDOS)
    expect(lerSessao(valor, SEGREDOS, agora + DURACAO_DA_SESSAO_MS)).toEqual(sessao)
    expect(lerSessao(valor, SEGREDOS, agora + DURACAO_DA_SESSAO_MS + 1)).toBeNull()
  })
})

describe('POST /conta/entrar (3.3)', () => {
  it('a senha certa: 200 DENTRO, e o cookie __Host-, HttpOnly, de 14 dias, com a geração da conta', async () => {
    const { cena, entrarCom } = montar()
    const resposta = await entrarCom(PEDIDO)
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toEqual(dentro(true))
    expect(resposta.headers.get('set-cookie')).toMatch(
      /^__Host-sessao=v1\.conta-1\.\d+\.0\.[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=1209600$/,
    )
    expect(cena.contas.procuras).toEqual(['maria@exemplo.com.br'])
    /* Sem erro antes, nada a zerar: nenhuma escrita. */
    expect(cena.contas.entradas).toHaveLength(0)
  })

  it('a conta ainda não confirmada entra (3.2, D), e a resposta diz que falta confirmar', async () => {
    const { cena, entrarCom } = montar()
    cena.contas.conta = { ...(cena.contas.conta as ContaParaEntrar), confirmada: false }
    const resposta = await entrarCom(PEDIDO)
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toEqual(dentro(false))
  })

  it('a senha errada e o e-mail sem conta: a mesma resposta, 401 "E-mail ou senha não conferem"', async () => {
    const { cena, entrarCom } = montar()
    const errada = await entrarCom({ ...PEDIDO, senha: 'outra senha qualquer' })
    const semConta = await entrarCom({ ...PEDIDO, email: 'joao@exemplo.com.br' })
    expect(errada.status).toBe(401)
    expect(semConta.status).toBe(401)
    const corpo = { erro: 'CREDENCIAIS_INVALIDAS', mensagem: 'E-mail ou senha não conferem' }
    expect(await errada.json()).toEqual(corpo)
    expect(await semConta.json()).toEqual(corpo)
    expect(errada.headers.get('set-cookie')).toBeNull()
    expect(cena.contas.erros).toEqual([{ errosSeguidos: 1, bloqueadaAte: null }])
  })

  it('o quinto erro seguido: 429 e 15 minutos de espera, gravados na conta; nem a senha certa entra antes', async () => {
    const { cena, entrarCom } = montar()
    for (let i = 1; i < ERROS_ATE_ESPERAR; i++) {
      expect((await entrarCom({ ...PEDIDO, senha: 'outra senha qualquer' })).status).toBe(401)
    }
    const quinta = await entrarCom({ ...PEDIDO, senha: 'outra senha qualquer' })
    expect(quinta.status).toBe(429)
    expect(await quinta.json()).toMatchObject({ erro: 'TENTATIVAS_DEMAIS' })
    const bloqueio = TERCA_8H_EM_BELEM.getTime() + ESPERA_DAS_TENTATIVAS_MS
    expect(cena.contas.erros.at(-1)).toEqual({ errosSeguidos: 0, bloqueadaAte: bloqueio })

    cena.agora = new Date(bloqueio - 1)
    expect((await entrarCom(PEDIDO)).status).toBe(429)

    /* Passados os 15 minutos, a senha certa entra, e o bloqueio sai da conta. */
    cena.agora = new Date(bloqueio)
    expect((await entrarCom(PEDIDO)).status).toBe(200)
    expect(cena.contas.entradas).toEqual([true])
  })

  it('o e-mail sem conta também espera na quinta: a espera não diz quem tem conta', async () => {
    const { cena, entrarCom } = montar()
    for (let i = 1; i < ERROS_ATE_ESPERAR; i++) {
      expect((await entrarCom({ ...PEDIDO, email: 'joao@exemplo.com.br' })).status).toBe(401)
    }
    const quinta = await entrarCom({ ...PEDIDO, email: 'joao@exemplo.com.br' })
    expect(quinta.status).toBe(429)
    expect(await quinta.json()).toMatchObject({ erro: 'TENTATIVAS_DEMAIS' })
    /* O contador guarda o e-mail resumido. */
    expect(cena.emailsNoLimite[0]).not.toContain('joao')
  })

  it('a entrada certa depois de erros zera a contagem', async () => {
    const { cena, entrarCom } = montar()
    await entrarCom({ ...PEDIDO, senha: 'outra senha qualquer' })
    expect((await entrarCom(PEDIDO)).status).toBe(200)
    expect(cena.contas.entradas).toEqual([false])
    expect(cena.contas.conta?.acesso.errosSeguidos).toBe(0)
  })

  it('a conta desativada (3.3, F): a senha errada recebe o 401 de sempre; só a certa ouve "desativada"', async () => {
    const { cena, entrarCom } = montar()
    cena.contas.conta = { ...(cena.contas.conta as ContaParaEntrar), ativa: false }
    expect((await entrarCom({ ...PEDIDO, senha: 'outra senha qualquer' })).status).toBe(401)
    const certa = await entrarCom(PEDIDO)
    expect(certa.status).toBe(403)
    expect(await certa.json()).toMatchObject({ erro: 'CONTA_DESATIVADA', mensagem: 'Esta conta está desativada' })
    expect(certa.headers.get('set-cookie')).toBeNull()
  })

  it('o log leva o id da conta, e nunca o e-mail ou a senha', async () => {
    const { entrarCom } = montar()
    await entrarCom(PEDIDO)
    for (let i = 0; i < ERROS_ATE_ESPERAR; i++) await entrarCom({ ...PEDIDO, senha: 'outra senha qualquer' })
    const tudo = logs.join('\n')
    expect(tudo).toContain('conta conta-1 entrou')
    for (const pessoal of ['maria', 'Maria', SENHA, 'outra senha']) expect(tudo).not.toContain(pessoal)
  })

  it('as conferências, da mais barata à mais cara: origem, ligado, corpo, limite, desafio', async () => {
    const { cena, entrarCom } = montar()
    expect((await entrarCom(PEDIDO, { Origin: 'https://outro.site' })).status).toBe(403)
    expect((await montar({ entrar: false }).entrarCom(PEDIDO)).status).toBe(503)
    expect((await entrarCom('{ não é json')).status).toBe(400)
    expect((await entrarCom({ email: 'maria@exemplo.com.br', senha: SENHA })).status).toBe(400)
    expect((await entrarCom({ ...PEDIDO, senha: 'x'.repeat(129) })).status).toBe(400)
    expect(cena.ipsNoLimite).toHaveLength(0)

    cena.limitePassa = false
    expect((await entrarCom(PEDIDO)).status).toBe(429)
    expect(cena.desafios).toHaveLength(0)

    cena.limitePassa = true
    cena.desafioPassa = false
    expect((await entrarCom(PEDIDO)).status).toBe(403)
    expect(cena.contas.procuras).toHaveLength(0)
  })
})

describe('GET /conta/sessao', () => {
  it('sem cookie: 401 SEM_SESSAO, sem cache', async () => {
    const { sessao } = montar()
    const resposta = await sessao()
    expect(resposta.status).toBe(401)
    expect(await resposta.json()).toMatchObject({ erro: 'SEM_SESSAO' })
    expect(resposta.headers.get('cache-control')).toBe('no-store')
  })

  it('o cookie de quem entrou: 200 DENTRO, e sem cookie novo no primeiro dia', async () => {
    const { entrarCom, sessao } = montar()
    const valor = valorDoCookie(await entrarCom(PEDIDO))
    const resposta = await sessao(valor)
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toEqual(dentro(true))
    expect(resposta.headers.get('set-cookie')).toBeNull()
  })

  it('depois de um dia, a resposta renova o cookie: mais 14 dias contados de agora', async () => {
    const { cena, entrarCom, sessao } = montar()
    const valor = valorDoCookie(await entrarCom(PEDIDO))
    cena.agora = new Date(TERCA_8H_EM_BELEM.getTime() + RENOVAR_DEPOIS_DE_MS + 1)
    const resposta = await sessao(valor)
    expect(resposta.status).toBe(200)
    expect(lerSessao(valorDoCookie(resposta), SEGREDOS, cena.agora.getTime())?.emitidaEm).toBe(cena.agora.getTime())
  })

  it('a geração que mudou (a senha trocada, o painel), a conta desativada e o cookie vencido: 401, e o cookie sai', async () => {
    const { cena, entrarCom, sessao } = montar()
    const valor = valorDoCookie(await entrarCom(PEDIDO))
    const base = cena.contas.conta as ContaParaEntrar

    cena.contas.conta = { ...base, acesso: { ...base.acesso, geracao: 1 } }
    const outraGeracao = await sessao(valor)
    expect(outraGeracao.status).toBe(401)
    expect(outraGeracao.headers.get('set-cookie')).toContain('Max-Age=0')

    cena.contas.conta = { ...base, ativa: false }
    expect((await sessao(valor)).status).toBe(401)

    cena.contas.conta = base
    cena.agora = new Date(TERCA_8H_EM_BELEM.getTime() + DURACAO_DA_SESSAO_MS + 1)
    expect((await sessao(valor)).status).toBe(401)
  })

  it('o cookie forjado não entra', async () => {
    const { sessao } = montar()
    const forjado = valorDaSessao(
      { contaId: 'conta-1', emitidaEm: TERCA_8H_EM_BELEM.getTime(), geracao: 0 },
      { atual: 'x'.repeat(43), anterior: null },
    )
    expect((await sessao(forjado)).status).toBe(401)
  })
})

describe('POST /conta/sair (3.3, D)', () => {
  it('204, e o cookie deste aparelho apagado', async () => {
    const { sair } = montar()
    const resposta = await sair()
    expect(resposta.status).toBe(204)
    expect(resposta.headers.get('set-cookie')).toBe(
      '__Host-sessao=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
    )
  })

  it('a origem de fora não apaga nada: 403', async () => {
    const { sair } = montar()
    expect((await sair('https://outro.site')).status).toBe(403)
  })
})
