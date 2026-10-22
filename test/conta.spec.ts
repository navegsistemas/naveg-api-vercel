/**
 * **`POST /conta`** — o cadastro (o PR 5 da #30), com portas falsas.
 *
 * O relógio está parado numa terça, 13/10/2026, 08:00 em Belém. Cada cenário confere uma conferência da rota, e
 * que ela para **antes** das mais caras. E o principal: **o e-mail já usado recebe a mesma resposta do novo**
 * (PO, 2026-10-21: "Não revelar").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { contaDoDocumento, type EscritaDaConta } from '@navegsistemas/domain'

import { criarApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { conferirSenha } from '../src/conta/senha.js'
import type {
  ConsultaDeSenhaVazada,
  ContasDoCliente,
  LeitorDoCatalogo,
  LimitePorIp,
  SegredoDeAcesso,
  TravaPorChave,
  VerificadorDoDesafio,
} from '../src/portas.js'
import { CONFIRA_O_EMAIL, LIMITE_DO_CORPO_DO_CADASTRO, type DependenciasDoCadastro } from '../src/rotas/conta.js'

const ORIGEM = 'https://agencia.naveg.com.br'
const TERCA_8H_EM_BELEM = new Date('2026-10-13T11:00:00Z')

const CONFIG: Config = {
  projetoFirebase: 'fluviapp-teste',
  contaDeLeitura: '{}',
  contaDeEscrita: '{}',
  chaveWebDoFirebase: null,
  empresaId: 'empresa-naveg',
  origensPermitidas: [ORIGEM],
  protecaoDoEnvio: null,
}

const CADASTRO = {
  nome: '  Maria   Souza ',
  dataNascimento: '1990-05-20',
  email: ' Maria@Exemplo.com.br ',
  telefone: '(91) 98888-7777',
  senha: 'rio e maré cheia',
  desafio: 'token-bom',
}

interface Gravada {
  contaId: string
  lote: readonly EscritaDaConta[]
  acesso: SegredoDeAcesso
  criadaEm: number
}

/** As contas, em memória. */
class Contas implements ContasDoCliente {
  readonly gravadas: Gravada[] = []
  readonly procuras: string[] = []
  falhar = false
  constructor(private readonly emails: Set<string> = new Set()) {}
  async existeComEmail(email: string) {
    this.procuras.push(email)
    return this.emails.has(email)
  }
  async criar(contaId: string, lote: readonly EscritaDaConta[], acesso: SegredoDeAcesso, criadaEm: number) {
    if (this.falhar) return false
    this.gravadas.push({ contaId, lote, acesso, criadaEm })
    return true
  }
}

function montar(opcoes: { cadastro?: false; contas?: Contas } = {}) {
  const cena = {
    contas: opcoes.contas ?? new Contas(),
    desafios: [] as string[],
    ipsNoLimite: [] as string[],
    travas: [] as string[],
    senhasConsultadas: [] as string[],
    desafioPassa: true,
    limitePassa: true,
    travaPassa: true,
    senhaVazada: false,
  }
  const catalogo: LeitorDoCatalogo = { ler: async () => Promise.reject(new Error('o cadastro não lê o catálogo')) }
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
  const trava: TravaPorChave = {
    travar: async (chave) => {
      cena.travas.push(chave)
      return cena.travaPassa
    },
  }
  const senhaVazada: ConsultaDeSenhaVazada = {
    vazada: async (senha) => {
      cena.senhasConsultadas.push(senha)
      return cena.senhaVazada
    },
  }
  const cadastro: DependenciasDoCadastro | null =
    opcoes.cadastro === false
      ? null
      : { contas: cena.contas, desafio, limite, trava, senhaVazada, sal: 'sal-de-teste', novoId: () => 'conta-1' }
  const app = criarApp({ config: CONFIG, catalogo, envio: null, cadastro, relogio: () => TERCA_8H_EM_BELEM })

  const enviar = (corpo: unknown, cabecalhos: Record<string, string> = {}) =>
    app.request('/conta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGEM, 'x-real-ip': '200.1.2.3', ...cabecalhos },
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    })
  return { cena, enviar, app }
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

describe('a conta nova', () => {
  it('202 "Confira seu e-mail", e a conta gravada na forma do domínio, sem a senha', async () => {
    const { cena, enviar } = montar()
    const resposta = await enviar(CADASTRO)
    expect(resposta.status).toBe(202)
    expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)

    expect(cena.contas.gravadas).toHaveLength(1)
    const [gravada] = cena.contas.gravadas as [Gravada]
    expect(gravada.contaId).toBe('conta-1')
    expect(gravada.criadaEm).toBe(TERCA_8H_EM_BELEM.getTime())
    expect(gravada.lote).toHaveLength(1)
    const [escrita] = gravada.lote
    expect(escrita).toMatchObject({ op: 'criar', caminho: 'contasDeCliente/conta-1' })
    const dados = (escrita as { dados: object }).dados
    /* O mesmo codec que o painel usa lê o que foi gravado. */
    expect(contaDoDocumento('conta-1', dados)).toMatchObject({
      nome: 'Maria Souza',
      email: 'maria@exemplo.com.br',
      telefone: '5591988887777',
      dataNascimento: '1990-05-20',
      documento: null,
      confirmadaEm: null,
      ativa: true,
    })
    /* A senha não entra na conta, nem em lugar nenhum fora do resumo. */
    expect(JSON.stringify(dados)).not.toContain(CADASTRO.senha)
    expect(gravada.acesso.geracao).toBe(0)
    expect(gravada.acesso.errosSeguidos).toBe(0)
    expect(gravada.acesso.resumoDaSenha).toMatch(/^scrypt\$15\$8\$3\$/)
    expect(await conferirSenha(CADASTRO.senha, gravada.acesso.resumoDaSenha)).toBe(true)
  })

  it('o log leva o id da conta, e nunca o nome, o e-mail, o celular ou a senha', async () => {
    const { enviar } = montar()
    await enviar(CADASTRO)
    const tudo = logs.join('\n')
    expect(tudo).toContain('conta conta-1 criada')
    for (const pessoal of ['Maria', 'maria@exemplo', '98888', CADASTRO.senha]) expect(tudo).not.toContain(pessoal)
  })

  it('o que vem a mais no corpo é ignorado: confirmação, documento e ativa não se mandam', async () => {
    const { cena, enviar } = montar()
    await enviar({ ...CADASTRO, confirmadaEm: 1, ativa: false, tipoDocumento: 'CPF', numeroDocumento: '52998224725' })
    const dados = (cena.contas.gravadas[0]?.lote[0] as { dados: Record<string, unknown> }).dados
    expect(dados['confirmadaEm']).toBeUndefined()
    expect(dados['tipoDocumento']).toBeUndefined()
    expect(dados['ativa']).toBe(true)
  })
})

describe('o e-mail que já tem conta não se revela', () => {
  it('a mesma resposta da conta nova, e nada gravado', async () => {
    const { cena, enviar } = montar({ contas: new Contas(new Set(['maria@exemplo.com.br'])) })
    const resposta = await enviar(CADASTRO)
    expect(resposta.status).toBe(202)
    expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)
    expect(cena.contas.procuras).toEqual(['maria@exemplo.com.br'])
    expect(cena.contas.gravadas).toHaveLength(0)
  })

  it('o segundo toque no botão, com a trava de pé, também: a mesma resposta, sem procurar nem gravar', async () => {
    const { cena, enviar } = montar()
    cena.travaPassa = false
    const resposta = await enviar(CADASTRO)
    expect(resposta.status).toBe(202)
    expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)
    expect(cena.contas.procuras).toHaveLength(0)
    expect(cena.contas.gravadas).toHaveLength(0)
  })

  it('a trava é do e-mail normalizado, resumido: "Maria@" e "maria@" são o mesmo, e o endereço não aparece', async () => {
    const { cena, enviar } = montar()
    await enviar(CADASTRO)
    await enviar({ ...CADASTRO, email: 'maria@exemplo.com.br' })
    expect(cena.travas[0]).toBe(cena.travas[1])
    expect(cena.travas[0]).not.toContain('maria')
  })
})

describe('as conferências, da mais barata à mais cara', () => {
  it('a origem de fora: 403, antes de tudo', async () => {
    const { cena, enviar } = montar()
    const resposta = await enviar(CADASTRO, { Origin: 'https://outro.site' })
    expect(resposta.status).toBe(403)
    expect(await resposta.json()).toMatchObject({ erro: 'ORIGEM_NAO_PERMITIDA' })
    expect(cena.ipsNoLimite).toHaveLength(0)
  })

  it('o cadastro desligado: 503', async () => {
    const { enviar } = montar({ cadastro: false })
    const resposta = await enviar(CADASTRO)
    expect(resposta.status).toBe(503)
    expect(await resposta.json()).toMatchObject({ erro: 'CADASTRO_INDISPONIVEL' })
  })

  it('o corpo que não é JSON, ou sem um dos textos: 400, sem gastar o limite', async () => {
    const { cena, enviar } = montar()
    expect((await enviar('{ não é json')).status).toBe(400)
    const { senha: _, ...semSenha } = CADASTRO
    expect((await enviar(semSenha)).status).toBe(400)
    expect((await enviar({ ...CADASTRO, nome: 42 })).status).toBe(400)
    expect(cena.ipsNoLimite).toHaveLength(0)
  })

  it('a senha mais longa que 128 caracteres: 400', async () => {
    const { enviar } = montar()
    expect((await enviar({ ...CADASTRO, senha: 'x'.repeat(129) })).status).toBe(400)
  })

  it('o corpo grande demais: 413', async () => {
    const { enviar } = montar()
    const resposta = await enviar({ ...CADASTRO, nome: 'a'.repeat(LIMITE_DO_CORPO_DO_CADASTRO) })
    expect(resposta.status).toBe(413)
  })

  it('o limite: 429, antes do desafio, com o IP resumido', async () => {
    const { cena, enviar } = montar()
    cena.limitePassa = false
    const resposta = await enviar(CADASTRO)
    expect(resposta.status).toBe(429)
    expect(await resposta.json()).toMatchObject({ erro: 'LIMITE_EXCEDIDO' })
    expect(cena.desafios).toHaveLength(0)
    expect(cena.ipsNoLimite[0]).not.toContain('200.1.2.3')
  })

  it('o desafio que não vale: 403, antes de conferir os campos', async () => {
    const { cena, enviar } = montar()
    cena.desafioPassa = false
    const resposta = await enviar({ ...CADASTRO, nome: '' })
    expect(resposta.status).toBe(403)
    expect(await resposta.json()).toMatchObject({ erro: 'DESAFIO_INVALIDO' })
  })

  it('os campos errados: 422 com cada pendência do domínio, e a senha nem é consultada', async () => {
    const { cena, enviar } = montar()
    const resposta = await enviar({ ...CADASTRO, nome: ' ', email: 'maria', telefone: '123', senha: 'curta' })
    expect(resposta.status).toBe(422)
    const corpo = (await resposta.json()) as { erro: string; pendencias: string[] }
    expect(corpo.erro).toBe('CADASTRO_INVALIDO')
    expect(corpo.pendencias.sort()).toEqual(['EMAIL', 'NOME', 'SENHA_CURTA', 'TELEFONE'])
    expect(cena.senhasConsultadas).toHaveLength(0)
  })

  it('menor de 18 anos, pela data de hoje em Belém: 422 MENOR_DE_IDADE', async () => {
    const { enviar } = montar()
    /* Faz 18 anos amanhã, 14/10/2026. */
    const resposta = await enviar({ ...CADASTRO, dataNascimento: '2008-10-14' })
    expect(await resposta.json()).toMatchObject({ erro: 'CADASTRO_INVALIDO', pendencias: ['MENOR_DE_IDADE'] })
    const noDia = await enviar({ ...CADASTRO, dataNascimento: '2008-10-13' })
    expect(noDia.status).toBe(202)
  })

  it('a senha comum: 422 SENHA_COMUM, sem ir à rede', async () => {
    const { cena, enviar } = montar()
    const resposta = await enviar({ ...CADASTRO, senha: 'Senha123' })
    expect(resposta.status).toBe(422)
    expect(await resposta.json()).toMatchObject({ erro: 'SENHA_FRACA', pendencias: ['SENHA_COMUM'] })
    expect(cena.senhasConsultadas).toHaveLength(0)
  })

  it('a senha vazada: 422 SENHA_VAZADA, e nada procurado nem gravado', async () => {
    const { cena, enviar } = montar()
    cena.senhaVazada = true
    const resposta = await enviar(CADASTRO)
    expect(await resposta.json()).toMatchObject({ erro: 'SENHA_FRACA', pendencias: ['SENHA_VAZADA'] })
    expect(cena.travas).toHaveLength(0)
    expect(cena.contas.gravadas).toHaveLength(0)
  })

  it('o banco que recusa: 500 sem detalhe', async () => {
    const contas = new Contas()
    contas.falhar = true
    const { enviar } = montar({ contas })
    const resposta = await enviar(CADASTRO)
    expect(resposta.status).toBe(500)
    expect(await resposta.json()).toEqual({ erro: 'FALHA_INTERNA', mensagem: 'Falha interna' })
  })
})

describe('GET /eco', () => {
  it('devolve o endereço que a API enxerga e os três cabeçalhos de onde ele sai, sem cache', async () => {
    const { app } = montar()
    const resposta = await app.request('/eco', {
      headers: { 'x-real-ip': '200.1.2.3', 'x-forwarded-for': '9.9.9.9, 200.1.2.3' },
    })
    expect(resposta.status).toBe(200)
    expect(resposta.headers.get('cache-control')).toBe('no-store')
    expect(await resposta.json()).toEqual({
      ip: '200.1.2.3',
      'x-real-ip': '200.1.2.3',
      'x-forwarded-for': '9.9.9.9, 200.1.2.3',
      'x-vercel-forwarded-for': null,
    })
  })
})
