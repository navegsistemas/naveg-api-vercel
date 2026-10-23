/**
 * **Esqueci a senha** — a 3.4 (naveg-api-vercel#30, o PR 8), com o link da ADR-0003 (seção 3).
 *
 * - **`POST /conta/senha/esqueci`** — o e-mail. A resposta é **sempre `202 CONFIRA_O_EMAIL`** (3.4, B: "Se houver uma
 *   conta com este e-mail, o link chega em instantes"), e o trabalho roda depois dela, no `waitUntil` da Vercel, como o
 *   "Reenviar": o tempo também não diz quem tem conta. Os freios são os do "Reenviar", num contador próprio: um a cada
 *   60 segundos e 5 por hora, por e-mail. Depois deles:
 *   - e-mail sem conta → nada;
 *   - conta desativada → o aviso "esta conta está desativada", com o WhatsApp, **sem link** (3.4, F);
 *   - as outras → o link de **1 hora**, que vale **uma vez só**; o novo invalida o anterior (3.4, A). A conta por
 *     confirmar também recebe: abrir o link prova o e-mail (3.4, E).
 * - **`POST /conta/senha/nova`** — o link aberto e a senha nova: `{ contaId, codigo, senha }`. As conferências, da mais
 *   barata à mais cara: o corpo, o limite por IP, o link (`410 LINK_INVALIDO` ou `LINK_VENCIDO`), a conta desativada
 *   (`403 CONTA_DESATIVADA`), a senha curta, a comum ou a vazada (`422 SENHA_FRACA`, com `SENHA_CURTA`, `SENHA_COMUM` ou
 *   `SENHA_VAZADA`). Aceita:
 *   - a senha nova, a **geração somada** (a conta sai dos outros aparelhos), os erros zerados, o bloqueio tirado e o
 *     link apagado, num lote só; a conta por confirmar fica confirmada (3.4, E);
 *   - **a pessoa fica dentro neste aparelho** (3.4, C): `200 DENTRO`, com o cookie da geração nova;
 *   - **o aviso "Sua senha foi trocada"** (3.4, D), com a hora e o WhatsApp, depois da resposta.
 *
 * O "Esqueci a senha" vale mesmo com a conta esperando os 15 minutos das tentativas (3.3, C).
 *
 * - **`POST /conta/senha/trocar`** — Meus dados (4.2, C; o PR 9b): `{ atual, nova }`, **só para quem entrou**
 *   (`conta/quem-entrou.ts`). A senha atual é a prova: quem pega o celular com a conta aberta não troca a senha sem
 *   ela. Por isso **o erro dela conta nas tentativas de entrar** (3.3, C): `403 CREDENCIAIS_INVALIDAS`, e o quinto
 *   erro seguido espera 15 minutos (`429 TENTATIVAS_DEMAIS`), como no entrar. A senha nova passa pelas conferências
 *   da troca pelo link (`422 SENHA_FRACA`). Aceita: o mesmo lote, a geração somada (a conta sai dos outros
 *   aparelhos), **dentro neste aparelho** (`200 DENTRO`, com o cookie novo) e o aviso "Sua senha foi trocada".
 *
 * O log leva o id da conta, nunca o nome, o e-mail ou a senha.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { normalizarEmail, TAMANHO_MINIMO_DA_SENHA } from '@navegsistemas/domain'

import {
  codigoConfere,
  codigoDeLink,
  linkDeTrocaDeSenha,
  PRAZO_DA_TROCA_MS,
  resumirCodigo,
} from '../conta/codigo.js'
import { emailDeContaDesativada, emailDeSenhaTrocada, emailDeTrocaDeSenha } from '../conta/emails.js'
import { quemEntrou } from '../conta/quem-entrou.js'
import { cabecalhoDaSessao, valorDaSessao, type SegredosDaSessao } from '../conta/sessao.js'
import { motivoDaSenhaFraca } from '../conta/senha-fraca.js'
import { conferirSenha, resumirSenha } from '../conta/senha.js'
import { ErroDaApi } from '../erros.js'
import type {
  CarteiroDeEmail,
  ConsultaDeSenhaVazada,
  ContasDoCliente,
  ContaDosMeusDados,
  DadosDaConta,
  LimitePorIp,
  Relogio,
  TravaPorChave,
} from '../portas.js'
import { ipDaRequisicao, resumirIp } from '../protecao/ip.js'
import { conferirOrigem } from '../protecao/origem.js'
import { CONFIRA_O_EMAIL, INTERVALO_DO_REENVIO_EM_SEGUNDOS, SENHA_MAIS_LONGA } from './conta.js'
import { FUSO_DA_OPERACAO } from './reservas.js'
import { dentro, ERROS_ATE_ESPERAR, ESPERA_DAS_TENTATIVAS_MS } from './sessao.js'

export const LIMITE_DO_CORPO_DA_SENHA = 1024

export interface DependenciasDaSenha {
  readonly contas: ContasDoCliente
  /** O limite por IP: o mesmo contador do cadastro. */
  readonly limite: LimitePorIp
  /** Os 60 segundos entre dois pedidos do mesmo e-mail. */
  readonly trava: TravaPorChave
  /** Os pedidos do mesmo e-mail na hora (o teto do "Reenviar"), num contador só deste link. */
  readonly limiteDoPedido: LimitePorIp
  readonly senhaVazada: ConsultaDeSenhaVazada
  readonly carteiro: CarteiroDeEmail
  readonly segredos: SegredosDaSessao
  /** O sal dos resumos do IP e do e-mail. */
  readonly sal: string
  /** O código do link. Os cenários passam um fixo. */
  readonly novoCodigo?: () => string
  /** O que roda depois da resposta (o `waitUntil` da Vercel). Sem ele, a tarefa corre solta. */
  readonly emSegundoPlano?: (tarefa: Promise<void>) => void
  /** A conta de quem entrou, para a troca com a senha atual (4.2, C). Sem ela, só essa rota responde `503`. */
  readonly dados?: DadosDaConta
}

export interface ContextoDaSenha {
  readonly origensPermitidas: readonly string[]
  readonly relogio: Relogio
  /** `null`: a troca de senha não está configurada neste ambiente. */
  readonly senha: DependenciasDaSenha | null
}

/** O id da conta e o código, como o link os leva (os mesmos da confirmação). */
const ID_DA_CONTA = /^[A-Za-z0-9_-]{1,40}$/
const CODIGO = /^[A-Za-z0-9_-]{43}$/
const EMAIL_MAIS_LONGO = 254

/** "22/10/2026, 19:40", na hora de Belém, para o aviso da troca. */
const HORA_DO_AVISO = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_DA_OPERACAO,
  dateStyle: 'short',
  timeStyle: 'short',
})

export function rotaDaSenha(contexto: ContextoDaSenha): Hono {
  const rota = new Hono()

  const ligada: MiddlewareHandler = async (c, proximo) => {
    conferirOrigem(c.req.header('origin'), contexto.origensPermitidas)
    if (contexto.senha === null) throw new ErroDaApi(503, 'SENHA_INDISPONIVEL', 'Troca de senha não configurada')
    await proximo()
  }
  const limiteDoCorpo = bodyLimit({
    maxSize: LIMITE_DO_CORPO_DA_SENHA,
    onError: () => {
      throw new ErroDaApi(413, 'CORPO_INVALIDO', 'Corpo grande demais')
    },
  })

  /** O corpo em JSON, ou `400`. */
  async function corpo(c: Context): Promise<Record<string, unknown>> {
    let bruto: unknown
    try {
      bruto = await c.req.json()
    } catch {
      throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é JSON')
    }
    return (typeof bruto === 'object' && bruto !== null ? bruto : {}) as Record<string, unknown>
  }

  /* O pedido do link (3.4, A e B): a resposta sai já; o resto, depois dela. */
  rota.post('/esqueci', ligada, limiteDoCorpo, async (c) => {
    const dep = contexto.senha as DependenciasDaSenha
    const { email: digitado } = await corpo(c)
    if (typeof digitado !== 'string' || digitado.length > EMAIL_MAIS_LONGO) {
      throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é um pedido de troca')
    }
    const ip = ipDaRequisicao((nome) => c.req.header(nome))
    if (!(await dep.limite.registrar(resumirIp(ip, dep.sal)))) {
      throw new ErroDaApi(429, 'LIMITE_EXCEDIDO', 'Pedidos demais deste endereço')
    }
    const email = normalizarEmail(digitado)
    if (email !== null) {
      const site = c.req.header('origin') as string
      const tarefa = mandarOLink(dep, email, site, contexto.relogio().getTime()).catch((erro: unknown) => {
        console.error(`pedido de troca de senha interrompido: ${(erro as Error).message}`)
      })
      ;(dep.emSegundoPlano ?? ((solta) => void solta))(tarefa)
    }
    return c.json(CONFIRA_O_EMAIL, 202)
  })

  /* O link aberto, com a senha nova (3.4, A, C, D e E). */
  rota.post('/nova', ligada, limiteDoCorpo, async (c) => {
    const dep = contexto.senha as DependenciasDaSenha
    const { contaId, codigo, senha } = await corpo(c)
    if (
      typeof contaId !== 'string' ||
      !ID_DA_CONTA.test(contaId) ||
      typeof codigo !== 'string' ||
      !CODIGO.test(codigo) ||
      typeof senha !== 'string' ||
      senha.length > SENHA_MAIS_LONGA
    ) {
      throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é uma senha nova')
    }

    const ip = ipDaRequisicao((nome) => c.req.header(nome))
    if (!(await dep.limite.registrar(resumirIp(ip, dep.sal)))) {
      throw new ErroDaApi(429, 'LIMITE_EXCEDIDO', 'Pedidos demais deste endereço')
    }

    const conta = await dep.contas.paraTrocarSenha(contaId)
    if (conta === null || conta.troca === null || !codigoConfere(codigo, conta.troca.resumoDoCodigo)) {
      throw new ErroDaApi(410, 'LINK_INVALIDO', 'Este link não vale')
    }
    const agora = contexto.relogio().getTime()
    if (agora > conta.troca.valeAte) throw new ErroDaApi(410, 'LINK_VENCIDO', 'Este link venceu')
    /* Desativada depois de pedir: o link não serve, e a tela diz o que fazer (3.3, F). */
    if (!conta.ativa) throw new ErroDaApi(403, 'CONTA_DESATIVADA', 'Esta conta está desativada')

    if (senha.length < TAMANHO_MINIMO_DA_SENHA) {
      throw new ErroDaApi(422, 'SENHA_FRACA', `A senha precisa de pelo menos ${TAMANHO_MINIMO_DA_SENHA} caracteres`, [
        'SENHA_CURTA',
      ])
    }
    const motivo = await motivoDaSenhaFraca(senha, dep.senhaVazada)
    if (motivo !== null) throw new ErroDaApi(422, 'SENHA_FRACA', 'A senha é comum ou vazada', [motivo])

    const geracao = conta.geracao + 1
    const trocada = await dep.contas.trocarSenha(contaId, {
      resumoDaSenha: await resumirSenha(senha),
      geracao,
      confirmarEm: conta.confirmadaEm === null ? agora : null,
      tirarBloqueio: conta.bloqueadaAte !== null,
    })
    if (!trocada) throw new ErroDaApi(500, 'FALHA_INTERNA', 'Falha interna')
    console.info(`conta ${contaId}: senha trocada${conta.confirmadaEm === null ? ', e o e-mail confirmado' : ''}`)

    /* Dentro neste aparelho, com a geração nova; fora dos outros (3.4, C). */
    c.header('Set-Cookie', cabecalhoDaSessao(valorDaSessao({ contaId, emitidaEm: agora, geracao }, dep.segredos)))

    avisarDaTroca(dep, contaId, conta.email, conta.nome, agora)
    return c.json(dentro(true), 200)
  })

  /* A troca em Meus dados, com a senha atual (4.2, C). */
  rota.post('/trocar', ligada, limiteDoCorpo, async (c) => {
    const dep = contexto.senha as DependenciasDaSenha
    if (dep.dados === undefined) throw new ErroDaApi(503, 'SENHA_INDISPONIVEL', 'Troca de senha não configurada')
    const { atual, nova } = await corpo(c)
    if (
      typeof atual !== 'string' ||
      atual.length > SENHA_MAIS_LONGA ||
      typeof nova !== 'string' ||
      nova.length > SENHA_MAIS_LONGA
    ) {
      throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é uma troca de senha')
    }

    const ip = ipDaRequisicao((nome) => c.req.header(nome))
    if (!(await dep.limite.registrar(resumirIp(ip, dep.sal)))) {
      throw new ErroDaApi(429, 'LIMITE_EXCEDIDO', 'Pedidos demais deste endereço')
    }

    const agora = contexto.relogio().getTime()
    const { conta, acesso } = await quemEntrou(c, dep.dados, dep.segredos, agora)
    await conferirSenhaAtual(dep.contas, { conta, acesso }, atual, agora)

    if (nova.length < TAMANHO_MINIMO_DA_SENHA) {
      throw new ErroDaApi(422, 'SENHA_FRACA', `A senha precisa de pelo menos ${TAMANHO_MINIMO_DA_SENHA} caracteres`, [
        'SENHA_CURTA',
      ])
    }
    const motivo = await motivoDaSenhaFraca(nova, dep.senhaVazada)
    if (motivo !== null) throw new ErroDaApi(422, 'SENHA_FRACA', 'A senha é comum ou vazada', [motivo])

    /* O mesmo lote da troca pelo link: a geração somada, os erros zerados, o bloqueio vencido tirado. */
    const geracao = acesso.geracao + 1
    const trocada = await dep.contas.trocarSenha(conta.id, {
      resumoDaSenha: await resumirSenha(nova),
      geracao,
      confirmarEm: null,
      tirarBloqueio: conta.bloqueadaAte !== null,
    })
    if (!trocada) throw new ErroDaApi(500, 'FALHA_INTERNA', 'Falha interna')
    console.info(`conta ${conta.id}: senha trocada em Meus dados`)

    c.header('Set-Cookie', cabecalhoDaSessao(valorDaSessao({ contaId: conta.id, emitidaEm: agora, geracao }, dep.segredos)))
    avisarDaTroca(dep, conta.id, conta.email, conta.nome, agora)
    return c.json(dentro(conta.confirmadaEm !== null), 200)
  })

  return rota
}

/**
 * **A senha atual**, a prova de Meus dados (4.2, B e C): enquanto a conta espera, nem a certa passa; o erro conta como
 * no entrar, e o quinto espera 15 minutos (3.3, C). Lança o erro da resposta; certa, não faz nada.
 */
export async function conferirSenhaAtual(
  contas: ContasDoCliente,
  { conta, acesso }: ContaDosMeusDados,
  senha: string,
  agora: number,
): Promise<void> {
  const tentativasDemais = new ErroDaApi(429, 'TENTATIVAS_DEMAIS', 'Tentativas demais: espere 15 minutos')
  if (conta.bloqueadaAte !== null && agora < conta.bloqueadaAte) throw tentativasDemais
  if (await conferirSenha(senha, acesso.resumoDaSenha)) return
  const erros = acesso.errosSeguidos + 1
  if (erros >= ERROS_ATE_ESPERAR) {
    await contas.registrarErroDeSenha(conta.id, 0, agora + ESPERA_DAS_TENTATIVAS_MS)
    console.info(`conta ${conta.id}: ${ERROS_ATE_ESPERAR} erros de senha seguidos, 15 minutos de espera`)
    throw tentativasDemais
  }
  await contas.registrarErroDeSenha(conta.id, erros, null)
  throw new ErroDaApi(403, 'CREDENCIAIS_INVALIDAS', 'A senha atual não confere')
}

/** O aviso "Sua senha foi trocada" (3.4, D), depois da resposta. */
function avisarDaTroca(dep: DependenciasDaSenha, contaId: string, email: string, nome: string, agora: number): void {
  const aviso = emailDeSenhaTrocada(email, nome, HORA_DO_AVISO.format(new Date(agora)))
  const tarefa = dep.carteiro.enviar(aviso).then(
    (saiu) => {
      if (!saiu) console.error(`conta ${contaId}: o aviso da troca de senha não saiu`)
    },
    (erro: unknown) => console.error(`conta ${contaId}: o aviso da troca de senha não saiu: ${(erro as Error).message}`),
  )
  ;(dep.emSegundoPlano ?? ((solta) => void solta))(tarefa)
}

/** O trabalho do pedido, depois da resposta: os freios, a conta, e o link ou o aviso da conta desativada. */
async function mandarOLink(dep: DependenciasDaSenha, email: string, site: string, agora: number): Promise<void> {
  const chave = resumirIp(email, dep.sal)
  if (!(await dep.trava.travar(`troca:${chave}`, INTERVALO_DO_REENVIO_EM_SEGUNDOS))) {
    console.info('troca de senha pedida antes dos 60 segundos: nada mandado')
    return
  }
  if (!(await dep.limiteDoPedido.registrar(chave))) {
    console.info('trocas de senha demais deste e-mail na hora: nada mandado')
    return
  }
  const conta = await dep.contas.paraMandarLink(email)
  if (conta === null) {
    console.info('troca de senha pedida para e-mail sem conta: nada mandado')
    return
  }
  if (!conta.ativa) {
    if (await dep.carteiro.enviar(emailDeContaDesativada(email))) {
      console.info(`conta ${conta.contaId}: desativada, o aviso mandado no lugar do link`)
    } else {
      console.error(`conta ${conta.contaId}: o aviso de conta desativada não saiu`)
    }
    return
  }
  const codigo = (dep.novoCodigo ?? codigoDeLink)()
  const troca = { resumoDoCodigo: resumirCodigo(codigo), valeAte: agora + PRAZO_DA_TROCA_MS }
  /* Sem o link gravado, o do e-mail não conferiria: melhor não mandar. O adaptador já disse o código no log. */
  if (!(await dep.contas.gravarTrocaDeSenha(conta.contaId, troca))) return
  const link = linkDeTrocaDeSenha(site, conta.contaId, codigo)
  if (await dep.carteiro.enviar(emailDeTrocaDeSenha(email, conta.nome, link))) {
    await dep.contas.registrarEnvio(conta.contaId, 'TROCA_DE_SENHA', agora)
    console.info(`conta ${conta.contaId}: link de troca de senha mandado`)
  } else {
    console.error(`conta ${conta.contaId}: o link de troca de senha não saiu`)
  }
}
