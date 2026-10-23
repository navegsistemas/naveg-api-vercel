/**
 * **`POST /conta`** — o cadastro (o PR 5 da #30), com portas falsas.
 *
 * O relógio está parado numa terça, 13/10/2026, 08:00 em Belém. Cada cenário confere uma conferência da rota, e
 * que ela para **antes** das mais caras. E o principal: **o e-mail já usado recebe a mesma resposta do novo**
 * (PO, 2026-10-21: "Não revelar").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { contaDoDocumento, type EscritaDaConta, type TipoDeLink } from '@navegsistemas/domain'

import { criarApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { PRAZO_DA_CONFIRMACAO_MS, resumirCodigo } from '../src/conta/codigo.js'
import { conferirSenha } from '../src/conta/senha.js'
import { lerSessao } from '../src/conta/sessao.js'
import type {
  CarteiroDeEmail,
  ConsultaDeSenhaVazada,
  ContaParaConfirmar,
  ContasDoCliente,
  LeitorDoCatalogo,
  LimitePorIp,
  MensagemDeEmail,
  SegredoDeAcesso,
  SegredoDeConfirmacao,
  TravaPorChave,
  VerificadorDoDesafio,
} from '../src/portas.js'
import {
  CONFIRA_O_EMAIL,
  EMAIL_CONFIRMADO,
  JA_CONFIRMADO,
  LIMITE_DO_CORPO_DO_CADASTRO,
  type DependenciasDoCadastro,
} from '../src/rotas/conta.js'

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
  confirmacao: SegredoDeConfirmacao
  criadaEm: number
}

/** As contas, em memória: as gravadas, o que a confirmação lê delas, e o que foi confirmado. */
class Contas implements ContasDoCliente {
  readonly gravadas: Gravada[] = []
  readonly procuras: string[] = []
  readonly envios: { contaId: string; tipo: TipoDeLink; em: number }[] = []
  readonly confirmadas: { contaId: string; em: number }[] = []
  readonly estado = new Map<string, ContaParaConfirmar>()
  falhar = false
  constructor(private readonly emails: Set<string> = new Set()) {}
  async existeComEmail(email: string) {
    this.procuras.push(email)
    return this.emails.has(email)
  }
  async criar(
    contaId: string,
    lote: readonly EscritaDaConta[],
    acesso: SegredoDeAcesso,
    confirmacao: SegredoDeConfirmacao,
    criadaEm: number,
  ) {
    if (this.falhar) return false
    this.gravadas.push({ contaId, lote, acesso, confirmacao, criadaEm })
    this.estado.set(contaId, { confirmadaEm: null, confirmacao, ativa: true, geracao: 0 })
    return true
  }
  /* Entrar tem os cenários dele (`sessao.spec.ts`); aqui, a conta só é criada e confirmada. */
  async paraEntrar() {
    return null
  }
  async registrarErroDeSenha() {
    return true
  }
  async registrarEntrada() {
    return true
  }
  async paraSessao() {
    return null
  }
  async registrarEnvio(contaId: string, tipo: TipoDeLink, em: number) {
    this.envios.push({ contaId, tipo, em })
  }
  async paraConfirmar(contaId: string) {
    return this.estado.get(contaId) ?? null
  }
  async confirmar(contaId: string, em: number) {
    if (this.falhar) return false
    this.confirmadas.push({ contaId, em })
    const antes = this.estado.get(contaId) as ContaParaConfirmar
    this.estado.set(contaId, { ...antes, confirmadaEm: em, confirmacao: null })
    return true
  }
  /* O reenvio acha a conta gravada pelo e-mail do lote. */
  async paraReenviar(email: string) {
    this.procuras.push(email)
    for (const gravada of this.gravadas) {
      const lida = contaDoDocumento(gravada.contaId, gravada.lote[0]?.op === 'criar' ? gravada.lote[0].dados : {})
      if (lida?.email === email) {
        const estado = this.estado.get(gravada.contaId)
        return { contaId: gravada.contaId, nome: lida.nome, confirmada: (estado?.confirmadaEm ?? null) !== null }
      }
    }
    return null
  }
  readonly trocas: { contaId: string; confirmacao: SegredoDeConfirmacao }[] = []
  async trocarConfirmacao(contaId: string, confirmacao: SegredoDeConfirmacao) {
    if (this.falhar) return false
    this.trocas.push({ contaId, confirmacao })
    const antes = this.estado.get(contaId) as ContaParaConfirmar
    this.estado.set(contaId, { ...antes, confirmacao })
    return true
  }
}

/** O carteiro, em memória. `saem = false`: o SMTP recusa. */
class Carteiro implements CarteiroDeEmail {
  readonly mandados: MensagemDeEmail[] = []
  saem = true
  async enviar(mensagem: MensagemDeEmail) {
    if (!this.saem) return false
    this.mandados.push(mensagem)
    return true
  }
}

/** O código fixo dos cenários: 43 caracteres base64url, como os de verdade. */
const CODIGO = 'c'.repeat(43)

/** Os segredos da sessão dos cenários: 32 caracteres ou mais, como a configuração pede. */
const SEGREDOS = { atual: 's'.repeat(43), anterior: null }

function montar(opcoes: { cadastro?: false; contas?: Contas; semSessao?: true } = {}) {
  const cena = {
    agora: TERCA_8H_EM_BELEM,
    carteiro: new Carteiro(),
    contas: opcoes.contas ?? new Contas(),
    desafios: [] as string[],
    ipsNoLimite: [] as string[],
    travas: [] as string[],
    senhasConsultadas: [] as string[],
    desafioPassa: true,
    limitePassa: true,
    travaPassa: true,
    senhaVazada: false,
    /* O código do próximo link: o reenvio troca, como os de verdade. */
    codigo: CODIGO,
    reenviosNoLimite: [] as string[],
    limiteDoReenvioPassa: true,
    /* O que a rota deixou para depois da resposta. */
    tarefas: [] as Promise<void>[],
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
      : {
          contas: cena.contas,
          desafio,
          limite,
          trava,
          senhaVazada,
          carteiro: cena.carteiro,
          sal: 'sal-de-teste',
          novoId: () => 'conta-1',
          novoCodigo: () => cena.codigo,
          segredosDaSessao: opcoes.semSessao ? null : SEGREDOS,
          limiteDoReenvio: {
            registrar: async (chave) => {
              cena.reenviosNoLimite.push(chave)
              return cena.limiteDoReenvioPassa
            },
          },
          emSegundoPlano: (tarefa) => void cena.tarefas.push(tarefa),
        }
  const app = criarApp({ config: CONFIG, catalogo, envio: null, cadastro, relogio: () => cena.agora })

  const postar = (caminho: string) => (corpo: unknown, cabecalhos: Record<string, string> = {}) =>
    app.request(caminho, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGEM, 'x-real-ip': '200.1.2.3', ...cabecalhos },
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    })
  const reenviarSemEsperar = postar('/conta/confirmacao/reenvio')
  /* O pedido, e depois as tarefas que ele deixou: a resposta já saiu quando elas rodam. */
  const reenviar = async (corpo: unknown, cabecalhos: Record<string, string> = {}) => {
    const resposta = await reenviarSemEsperar(corpo, cabecalhos)
    await Promise.all(cena.tarefas.splice(0))
    return resposta
  }
  return { cena, enviar: postar('/conta'), confirmar: postar('/conta/confirmacao'), reenviar, reenviarSemEsperar, app }
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

describe('o e-mail de confirmação (3.2)', () => {
  it('sai para o e-mail normalizado, com o link do site de onde veio o cadastro, e o código depois do #', async () => {
    const { cena, enviar } = montar()
    await enviar(CADASTRO)
    expect(cena.carteiro.mandados).toHaveLength(1)
    const [email] = cena.carteiro.mandados as [MensagemDeEmail]
    expect(email.para).toBe('maria@exemplo.com.br')
    expect(email.assunto).toBe('Confirme seu e-mail na NAVEG')
    const link = `${ORIGEM}/conta/confirmar#conta-1.${CODIGO}`
    expect(email.texto).toContain(link)
    expect(email.texto).toContain('Olá, Maria!')
    expect(email.texto).toContain('O link vale por 24 horas.')
    expect(email.html).toContain(`href="${link}"`)
  })

  it('a conta guarda só o resumo do código, valendo 24 horas; e o envio fica registrado para o painel', async () => {
    const { cena, enviar } = montar()
    await enviar(CADASTRO)
    const [gravada] = cena.contas.gravadas as [Gravada]
    expect(gravada.confirmacao).toEqual({
      resumoDoCodigo: resumirCodigo(CODIGO),
      valeAte: TERCA_8H_EM_BELEM.getTime() + PRAZO_DA_CONFIRMACAO_MS,
    })
    expect(JSON.stringify(gravada)).not.toContain(CODIGO)
    expect(cena.contas.envios).toEqual([{ contaId: 'conta-1', tipo: 'CONFIRMACAO', em: TERCA_8H_EM_BELEM.getTime() }])
  })

  it('o nome vai escapado no HTML: é texto que a pessoa digitou', async () => {
    const { cena, enviar } = montar()
    await enviar({ ...CADASTRO, nome: '<b>Maria</b> Souza' })
    const [email] = cena.carteiro.mandados as [MensagemDeEmail]
    expect(email.html).toContain('Olá, &lt;b&gt;Maria&lt;/b&gt;!')
    expect(email.html).not.toContain('<b>Maria')
  })

  it('o e-mail que não sai não muda a resposta: 202, a conta gravada, o erro no log e nada registrado', async () => {
    const { cena, enviar } = montar()
    cena.carteiro.saem = false
    const resposta = await enviar(CADASTRO)
    expect(resposta.status).toBe(202)
    expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)
    expect(cena.contas.gravadas).toHaveLength(1)
    expect(cena.contas.envios).toHaveLength(0)
    expect(logs.join('\n')).toContain('conta conta-1: o link de confirmação não saiu')
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

  it('o dono do e-mail recebe o aviso, sem link de confirmação (PO, 2026-10-21)', async () => {
    const { cena, enviar } = montar({ contas: new Contas(new Set(['maria@exemplo.com.br'])) })
    await enviar(CADASTRO)
    expect(cena.carteiro.mandados).toHaveLength(1)
    const [aviso] = cena.carteiro.mandados as [MensagemDeEmail]
    expect(aviso.para).toBe('maria@exemplo.com.br')
    expect(aviso.texto).toContain(
      "Alguém tentou criar uma conta com este e-mail. Se foi você, entre ou use 'Esqueci a senha'.",
    )
    expect(aviso.texto).toContain(`${ORIGEM}/conta`)
    expect(aviso.texto).not.toContain('/conta/confirmar')
  })

  it('o aviso que não sai também não muda a resposta', async () => {
    const { cena, enviar } = montar({ contas: new Contas(new Set(['maria@exemplo.com.br'])) })
    cena.carteiro.saem = false
    const resposta = await enviar(CADASTRO)
    expect(resposta.status).toBe(202)
    expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)
  })

  it('o segundo toque no botão, com a trava de pé, também: a mesma resposta, sem procurar, gravar nem mandar', async () => {
    const { cena, enviar } = montar()
    cena.travaPassa = false
    const resposta = await enviar(CADASTRO)
    expect(resposta.status).toBe(202)
    expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)
    expect(cena.contas.procuras).toHaveLength(0)
    expect(cena.contas.gravadas).toHaveLength(0)
    expect(cena.carteiro.mandados).toHaveLength(0)
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

describe('POST /conta/confirmacao (3.2)', () => {
  /** Cadastra a Maria, e devolve a cena pronta para abrir o link. */
  async function cadastrada() {
    const montado = montar()
    await montado.enviar(CADASTRO)
    return montado
  }

  it('o link certo, dentro das 24 horas: 200 EMAIL_CONFIRMADO, e a conta confirmada naquela hora', async () => {
    const { cena, confirmar } = await cadastrada()
    cena.agora = new Date(TERCA_8H_EM_BELEM.getTime() + 60 * 60 * 1000)
    const resposta = await confirmar({ contaId: 'conta-1', codigo: CODIGO })
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toEqual(EMAIL_CONFIRMADO)
    expect(cena.contas.confirmadas).toEqual([{ contaId: 'conta-1', em: cena.agora.getTime() }])
    expect(logs.join('\n')).toContain('conta conta-1 confirmada')
  })

  it('quem confirma fica dentro da conta (3.2, C): o cookie da sessão, assinado, com a geração da conta', async () => {
    const { cena, confirmar } = await cadastrada()
    const resposta = await confirmar({ contaId: 'conta-1', codigo: CODIGO })
    const cookie = resposta.headers.get('set-cookie') as string
    expect(cookie).toMatch(/^__Host-sessao=v1\.conta-1\.\d+\.0\.[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=1209600$/)
    const valor = cookie.split(';')[0]?.slice('__Host-sessao='.length) as string
    expect(lerSessao(valor, SEGREDOS, cena.agora.getTime())).toEqual({
      contaId: 'conta-1',
      emitidaEm: cena.agora.getTime(),
      geracao: 0,
    })
  })

  it('a conta desativada confirma o e-mail, mas não entra; sem o segredo da sessão, também não', async () => {
    const desativada = await cadastrada()
    desativada.cena.contas.estado.set('conta-1', {
      ...(desativada.cena.contas.estado.get('conta-1') as ContaParaConfirmar),
      ativa: false,
    })
    const resposta = await desativada.confirmar({ contaId: 'conta-1', codigo: CODIGO })
    expect(resposta.status).toBe(200)
    expect(resposta.headers.get('set-cookie')).toBeNull()

    const semSessao = montar({ semSessao: true })
    await semSessao.enviar(CADASTRO)
    const semCookie = await semSessao.confirmar({ contaId: 'conta-1', codigo: CODIGO })
    expect(semCookie.status).toBe(200)
    expect(semCookie.headers.get('set-cookie')).toBeNull()
  })

  it('o link aberto de novo, depois de confirmado: 200 JA_CONFIRMADO, sem confirmar outra vez', async () => {
    const { cena, confirmar } = await cadastrada()
    await confirmar({ contaId: 'conta-1', codigo: CODIGO })
    const resposta = await confirmar({ contaId: 'conta-1', codigo: CODIGO })
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toEqual(JA_CONFIRMADO)
    expect(cena.contas.confirmadas).toHaveLength(1)
  })

  it('no último milissegundo das 24 horas ainda vale; um depois, 410 LINK_VENCIDO', async () => {
    const vale = await cadastrada()
    vale.cena.agora = new Date(TERCA_8H_EM_BELEM.getTime() + PRAZO_DA_CONFIRMACAO_MS)
    expect((await vale.confirmar({ contaId: 'conta-1', codigo: CODIGO })).status).toBe(200)

    const venceu = await cadastrada()
    venceu.cena.agora = new Date(TERCA_8H_EM_BELEM.getTime() + PRAZO_DA_CONFIRMACAO_MS + 1)
    const resposta = await venceu.confirmar({ contaId: 'conta-1', codigo: CODIGO })
    expect(resposta.status).toBe(410)
    expect(await resposta.json()).toMatchObject({ erro: 'LINK_VENCIDO' })
    expect(venceu.cena.contas.confirmadas).toHaveLength(0)
  })

  it('o código errado, ou a conta que não existe: 410 LINK_INVALIDO, a mesma resposta', async () => {
    const { cena, confirmar } = await cadastrada()
    const errado = await confirmar({ contaId: 'conta-1', codigo: 'd'.repeat(43) })
    expect(errado.status).toBe(410)
    expect(await errado.json()).toMatchObject({ erro: 'LINK_INVALIDO' })
    const outra = await confirmar({ contaId: 'conta-2', codigo: CODIGO })
    expect(outra.status).toBe(410)
    expect(await outra.json()).toMatchObject({ erro: 'LINK_INVALIDO' })
    expect(cena.contas.confirmadas).toHaveLength(0)
  })

  it('o corpo sem a forma do link: 400, sem gastar o limite', async () => {
    const { cena, confirmar } = await cadastrada()
    const antes = cena.ipsNoLimite.length
    expect((await confirmar('{ não é json')).status).toBe(400)
    expect((await confirmar({ contaId: 'conta-1' })).status).toBe(400)
    expect((await confirmar({ contaId: 'conta-1', codigo: 'curto' })).status).toBe(400)
    expect((await confirmar({ contaId: 'conta/1', codigo: CODIGO })).status).toBe(400)
    expect(cena.ipsNoLimite).toHaveLength(antes)
  })

  it('a origem de fora: 403; o cadastro desligado: 503; o limite: 429', async () => {
    const { cena, confirmar } = await cadastrada()
    expect((await confirmar({ contaId: 'conta-1', codigo: CODIGO }, { Origin: 'https://outro.site' })).status).toBe(403)
    cena.limitePassa = false
    expect((await confirmar({ contaId: 'conta-1', codigo: CODIGO })).status).toBe(429)
    expect(cena.contas.confirmadas).toHaveLength(0)

    const desligado = montar({ cadastro: false })
    expect((await desligado.confirmar({ contaId: 'conta-1', codigo: CODIGO })).status).toBe(503)
  })

  it('o banco que recusa: 500 sem detalhe', async () => {
    const { cena, confirmar } = await cadastrada()
    cena.contas.falhar = true
    const resposta = await confirmar({ contaId: 'conta-1', codigo: CODIGO })
    expect(resposta.status).toBe(500)
    expect(await resposta.json()).toEqual({ erro: 'FALHA_INTERNA', mensagem: 'Falha interna' })
  })
})

describe('POST /conta/confirmacao/reenvio (3.2, B)', () => {
  const MARIA = { email: ' Maria@Exemplo.com.br ' }
  const NOVO = 'n'.repeat(43)

  /** A Maria cadastrada, o primeiro e-mail já mandado, e o código do próximo link. */
  async function cadastrada() {
    const montado = montar()
    await montado.enviar(CADASTRO)
    montado.cena.carteiro.mandados.length = 0
    montado.cena.contas.envios.length = 0
    montado.cena.codigo = NOVO
    return montado
  }

  it('um link novo, de 24 horas a contar do reenvio, mandado à Maria', async () => {
    const dep = await cadastrada()
    dep.cena.agora = new Date(TERCA_8H_EM_BELEM.getTime() + 2 * 60 * 60 * 1000)
    const resposta = await dep.reenviar(MARIA)
    expect(resposta.status).toBe(202)
    expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)

    const [troca] = dep.cena.contas.trocas
    expect(troca?.contaId).toBe('conta-1')
    expect(troca?.confirmacao).toEqual({
      resumoDoCodigo: resumirCodigo(NOVO),
      valeAte: dep.cena.agora.getTime() + PRAZO_DA_CONFIRMACAO_MS,
    })
    const [mandado] = dep.cena.carteiro.mandados
    expect(mandado?.para).toBe('maria@exemplo.com.br')
    expect(mandado?.texto).toContain(`${ORIGEM}/conta/confirmar#conta-1.${NOVO}`)
    expect(dep.cena.contas.envios).toEqual([{ contaId: 'conta-1', tipo: 'CONFIRMACAO', em: dep.cena.agora.getTime() }])
    expect(logs.join('\n')).toContain('conta conta-1: link de confirmação reenviado')
    expect(logs.join('\n')).not.toContain('maria@')
  })

  it('o link novo invalida o anterior: o do cadastro dá 410 LINK_INVALIDO, o reenviado confirma', async () => {
    const { reenviar, confirmar } = await cadastrada()
    await reenviar(MARIA)
    const velho = await confirmar({ contaId: 'conta-1', codigo: CODIGO })
    expect(velho.status).toBe(410)
    expect(await velho.json()).toMatchObject({ erro: 'LINK_INVALIDO' })
    const novo = await confirmar({ contaId: 'conta-1', codigo: NOVO })
    expect(novo.status).toBe(200)
    expect(await novo.json()).toEqual(EMAIL_CONFIRMADO)
  })

  it('a mesma resposta para o e-mail sem conta, a conta já confirmada e o e-mail sem forma, sem mandar nada', async () => {
    const { cena, reenviar, confirmar } = await cadastrada()
    const semConta = await reenviar({ email: 'ninguem@exemplo.com.br' })
    expect(semConta.status).toBe(202)
    expect(await semConta.json()).toEqual(CONFIRA_O_EMAIL)

    await confirmar({ contaId: 'conta-1', codigo: CODIGO })
    const confirmada = await reenviar(MARIA)
    expect(confirmada.status).toBe(202)
    expect(await confirmada.json()).toEqual(CONFIRA_O_EMAIL)

    const semForma = await reenviar({ email: 'não é e-mail' })
    expect(semForma.status).toBe(202)
    expect(await semForma.json()).toEqual(CONFIRA_O_EMAIL)

    expect(cena.carteiro.mandados).toHaveLength(0)
    expect(cena.contas.trocas).toHaveLength(0)
    expect(logs.join('\n')).toContain('reenvio para e-mail sem conta: nada mandado')
    expect(logs.join('\n')).toContain('conta conta-1: reenvio com o e-mail já confirmado, nada mandado')
  })

  it('a resposta não espera o e-mail: ele sai depois dela, na tarefa deixada para trás', async () => {
    const { cena, reenviarSemEsperar } = await cadastrada()
    let soltar = () => {}
    const enviar = cena.carteiro.enviar.bind(cena.carteiro)
    cena.carteiro.enviar = async (mensagem) => {
      await new Promise<void>((pronto) => (soltar = pronto))
      return enviar(mensagem)
    }
    const resposta = await reenviarSemEsperar(MARIA)
    expect(resposta.status).toBe(202)
    expect(cena.tarefas).toHaveLength(1)
    expect(cena.carteiro.mandados).toHaveLength(0)
    soltar()
    await Promise.all(cena.tarefas.splice(0))
    expect(cena.carteiro.mandados).toHaveLength(1)
  })

  it('dentro dos 60 segundos, nada sai, e o toque não gasta um dos 5 da hora', async () => {
    const { cena, reenviar } = await cadastrada()
    cena.travaPassa = false
    expect((await reenviar(MARIA)).status).toBe(202)
    expect(cena.travas.at(-1)).toMatch(/^reenvio:/)
    expect(cena.reenviosNoLimite).toHaveLength(0)
    expect(cena.carteiro.mandados).toHaveLength(0)
    expect(logs.join('\n')).toContain('reenvio antes dos 60 segundos: nada mandado')
  })

  it('passou dos 5 na hora, nada sai: a mesma resposta', async () => {
    const { cena, reenviar } = await cadastrada()
    cena.limiteDoReenvioPassa = false
    const resposta = await reenviar(MARIA)
    expect(resposta.status).toBe(202)
    expect(await resposta.json()).toEqual(CONFIRA_O_EMAIL)
    expect(cena.carteiro.mandados).toHaveLength(0)
    expect(cena.contas.trocas).toHaveLength(0)
    expect(logs.join('\n')).toContain('reenvios demais deste e-mail na hora: nada mandado')
  })

  it('o link novo que o banco recusa não é mandado; o e-mail que não sai fica no log, e a resposta não muda', async () => {
    const recusado = await cadastrada()
    recusado.cena.contas.falhar = true
    expect((await recusado.reenviar(MARIA)).status).toBe(202)
    expect(recusado.cena.carteiro.mandados).toHaveLength(0)

    const semCorreio = await cadastrada()
    semCorreio.cena.carteiro.saem = false
    expect((await semCorreio.reenviar(MARIA)).status).toBe(202)
    expect(semCorreio.cena.contas.envios).toHaveLength(0)
    expect(logs.join('\n')).toContain('conta conta-1: o link reenviado não saiu')
  })

  it('o corpo sem e-mail: 400, sem gastar o limite; a origem de fora: 403; desligado: 503; o limite por IP: 429', async () => {
    const { cena, reenviar } = await cadastrada()
    const antes = cena.ipsNoLimite.length
    expect((await reenviar('{ não é json')).status).toBe(400)
    expect((await reenviar({})).status).toBe(400)
    expect((await reenviar({ email: 'a'.repeat(255) })).status).toBe(400)
    expect(cena.ipsNoLimite).toHaveLength(antes)

    expect((await reenviar(MARIA, { Origin: 'https://outro.site' })).status).toBe(403)
    cena.limitePassa = false
    expect((await reenviar(MARIA)).status).toBe(429)
    expect(cena.carteiro.mandados).toHaveLength(0)

    const desligado = montar({ cadastro: false })
    expect((await desligado.reenviar(MARIA)).status).toBe(503)
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
