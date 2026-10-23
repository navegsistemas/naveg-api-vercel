/**
 * **Trocar o e-mail** — Meus dados (4.2, B; naveg-api-vercel#30, o PR 9c): "com a senha atual; o novo só vale depois de
 * confirmado pelo link (24 horas), e o antigo recebe um aviso. Se o novo já for de outra conta, a resposta é a mesma."
 *
 * - **`POST /conta/email/trocar`** — `{ senha, novoEmail }`, **só para quem entrou** (`conta/quem-entrou.ts`). A senha
 *   atual é a prova, conferida como na troca de senha: o erro conta nas tentativas de entrar (`403
 *   CREDENCIAIS_INVALIDAS`; o quinto, `429 TENTATIVAS_DEMAIS`). O e-mail sem a forma de um e-mail, ou o mesmo de agora,
 *   é `422 CADASTRO_INVALIDO`, com `EMAIL`. Depois disso a resposta é **sempre `202 CONFIRA_O_EMAIL`**, e o trabalho
 *   roda depois dela, no `waitUntil`, como no "Reenviar": o tempo não diz se o e-mail novo já tem conta. O trabalho:
 *   - os freios, por conta: um pedido a cada 60 segundos e 5 por hora. Sem eles, a conta mandaria e-mails a qualquer
 *     endereço, sem fim;
 *   - **o aviso ao e-mail antigo, já no pedido** (PO, 2026-10-23): a dona da conta fica sabendo enquanto o link ainda
 *     não foi aberto, e pode trocar a senha a tempo;
 *   - o e-mail novo **já de outra conta** → o aviso do cadastro repetido, a esse endereço, sem link (PO, 2026-10-23);
 *   - os outros → o link de **24 horas**, gravado com o e-mail novo nos segredos; o novo pedido invalida o anterior.
 * - **`POST /conta/email/confirmacao`** — o link aberto: `{ contaId, codigo }`. Não pede a sessão: o link pode ser
 *   aberto noutro aparelho, e o código prova o e-mail. Respostas: `410 LINK_INVALIDO` ou `LINK_VENCIDO`; `403
 *   CONTA_DESATIVADA`; `409 EMAIL_EM_USO`, quando o e-mail ficou de outra conta entre o pedido e o link (aqui pode
 *   dizer: quem abriu o link é o dono do endereço); e `200 EMAIL_TROCADO`. A conta por confirmar fica confirmada: o
 *   link provou o e-mail novo (é a "Corrigir o e-mail" da 3.2, E).
 *
 * A troca não tira a conta de outros aparelhos: quem entra continua sendo a mesma pessoa, com a mesma senha. O log leva
 * o id da conta, nunca o e-mail.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { normalizarEmail } from '@navegsistemas/domain'

import { codigoConfere, codigoDeLink, linkDeTrocaDeEmail, PRAZO_DA_CONFIRMACAO_MS, resumirCodigo } from '../conta/codigo.js'
import { emailDeEmailJaUsado, emailDeTrocaDeEmail, emailDeTrocaDeEmailPedida } from '../conta/emails.js'
import { quemEntrou } from '../conta/quem-entrou.js'
import type { SegredosDaSessao } from '../conta/sessao.js'
import { ErroDaApi } from '../erros.js'
import type { CarteiroDeEmail, ContasDoCliente, DadosDaConta, LimitePorIp, Relogio, TravaPorChave } from '../portas.js'
import { ipDaRequisicao, resumirIp } from '../protecao/ip.js'
import { conferirOrigem } from '../protecao/origem.js'
import { CONFIRA_O_EMAIL, INTERVALO_DO_REENVIO_EM_SEGUNDOS, SENHA_MAIS_LONGA, TRAVA_DO_EMAIL_EM_SEGUNDOS } from './conta.js'
import { conferirSenhaAtual } from './senha.js'

export const LIMITE_DO_CORPO_DO_EMAIL = 1024

/** A troca feita. */
export const EMAIL_TROCADO = { situacao: 'EMAIL_TROCADO' } as const

export interface DependenciasDoEmail {
  /** A procura pelo e-mail e o erro da senha atual. */
  readonly contas: ContasDoCliente
  /** A conta de quem entrou, o pedido guardado e a troca. */
  readonly dados: DadosDaConta
  readonly segredos: SegredosDaSessao
  /** O limite por IP: o mesmo contador do cadastro. */
  readonly limite: LimitePorIp
  /** Os 60 segundos entre dois pedidos da mesma conta, e a trava do e-mail na troca, a mesma do cadastro. */
  readonly trava: TravaPorChave
  /** Os pedidos da mesma conta na hora (o teto do "Reenviar"), num contador só deste link. */
  readonly limiteDoPedido: LimitePorIp
  readonly carteiro: CarteiroDeEmail
  /** O sal dos resumos do IP, do e-mail e da conta. */
  readonly sal: string
  /** O código do link. Os cenários passam um fixo. */
  readonly novoCodigo?: () => string
  /** O que roda depois da resposta (o `waitUntil` da Vercel). Sem ele, a tarefa corre solta. */
  readonly emSegundoPlano?: (tarefa: Promise<void>) => void
}

export interface ContextoDoEmail {
  readonly origensPermitidas: readonly string[]
  readonly relogio: Relogio
  /** `null`: a troca de e-mail não está configurada neste ambiente. */
  readonly email: DependenciasDoEmail | null
}

const ID_DA_CONTA = /^[A-Za-z0-9_-]{1,40}$/
const CODIGO = /^[A-Za-z0-9_-]{43}$/
const EMAIL_MAIS_LONGO = 254

export function rotaDoEmail(contexto: ContextoDoEmail): Hono {
  const rota = new Hono()

  const ligada: MiddlewareHandler = async (c, proximo) => {
    conferirOrigem(c.req.header('origin'), contexto.origensPermitidas)
    /* Pede o que o cadastro pede (o e-mail sai) e a sessão: sem um dos dois, o mesmo código do cadastro. */
    if (contexto.email === null) throw new ErroDaApi(503, 'CADASTRO_INDISPONIVEL', 'Troca de e-mail não configurada')
    await proximo()
  }
  const limiteDoCorpo = bodyLimit({
    maxSize: LIMITE_DO_CORPO_DO_EMAIL,
    onError: () => {
      throw new ErroDaApi(413, 'CORPO_INVALIDO', 'Corpo grande demais')
    },
  })

  async function corpo(c: Context): Promise<Record<string, unknown>> {
    let bruto: unknown
    try {
      bruto = await c.req.json()
    } catch {
      throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é JSON')
    }
    return (typeof bruto === 'object' && bruto !== null ? bruto : {}) as Record<string, unknown>
  }

  async function dentroDoLimite(c: Context, dep: DependenciasDoEmail): Promise<void> {
    const ip = ipDaRequisicao((nome) => c.req.header(nome))
    if (!(await dep.limite.registrar(resumirIp(ip, dep.sal)))) {
      throw new ErroDaApi(429, 'LIMITE_EXCEDIDO', 'Pedidos demais deste endereço')
    }
  }

  /* O pedido (4.2, B): a resposta sai já; o resto, depois dela. */
  rota.post('/trocar', ligada, limiteDoCorpo, async (c) => {
    const dep = contexto.email as DependenciasDoEmail
    const { senha, novoEmail: digitado } = await corpo(c)
    if (
      typeof senha !== 'string' ||
      senha.length > SENHA_MAIS_LONGA ||
      typeof digitado !== 'string' ||
      digitado.length > EMAIL_MAIS_LONGO
    ) {
      throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é uma troca de e-mail')
    }
    await dentroDoLimite(c, dep)

    const agora = contexto.relogio().getTime()
    const lida = await quemEntrou(c, dep.dados, dep.segredos, agora)
    await conferirSenhaAtual(dep.contas, lida, senha, agora)

    const novoEmail = normalizarEmail(digitado)
    if (novoEmail === null || novoEmail === lida.conta.email) {
      throw new ErroDaApi(422, 'CADASTRO_INVALIDO', 'O e-mail novo não serve', ['EMAIL'])
    }

    const site = c.req.header('origin') as string
    const { id, nome, email } = lida.conta
    const tarefa = pedirATroca(dep, { contaId: id, nome, email }, novoEmail, site, agora).catch((erro: unknown) => {
      console.error(`conta ${id}: pedido de troca de e-mail interrompido: ${(erro as Error).message}`)
    })
    ;(dep.emSegundoPlano ?? ((solta) => void solta))(tarefa)
    return c.json(CONFIRA_O_EMAIL, 202)
  })

  /* O link aberto no e-mail novo. */
  rota.post('/confirmacao', ligada, limiteDoCorpo, async (c) => {
    const dep = contexto.email as DependenciasDoEmail
    const { contaId, codigo } = await corpo(c)
    if (typeof contaId !== 'string' || !ID_DA_CONTA.test(contaId) || typeof codigo !== 'string' || !CODIGO.test(codigo)) {
      throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é uma confirmação')
    }
    await dentroDoLimite(c, dep)

    const conta = await dep.dados.paraTrocarEmail(contaId)
    if (conta === null || conta.troca === null || !codigoConfere(codigo, conta.troca.resumoDoCodigo)) {
      throw new ErroDaApi(410, 'LINK_INVALIDO', 'Este link não vale')
    }
    const agora = contexto.relogio().getTime()
    if (agora > conta.troca.valeAte) throw new ErroDaApi(410, 'LINK_VENCIDO', 'Este link venceu')
    if (!conta.ativa) throw new ErroDaApi(403, 'CONTA_DESATIVADA', 'Esta conta está desativada')

    /* A trava do cadastro, no e-mail novo: um cadastro com ele, ao mesmo tempo, não vira uma segunda conta. */
    const novoEmail = conta.troca.novoEmail
    const emUso = new ErroDaApi(409, 'EMAIL_EM_USO', 'O e-mail novo já é de outra conta')
    if (!(await dep.trava.travar(resumirIp(novoEmail, dep.sal), TRAVA_DO_EMAIL_EM_SEGUNDOS))) throw emUso
    if (await dep.contas.existeComEmail(novoEmail)) throw emUso

    const trocado = await dep.dados.trocarEmail(contaId, novoEmail, conta.confirmadaEm === null ? agora : null)
    if (!trocado) throw new ErroDaApi(500, 'FALHA_INTERNA', 'Falha interna')
    console.info(`conta ${contaId}: e-mail trocado${conta.confirmadaEm === null ? ', e confirmado' : ''}`)
    return c.json(EMAIL_TROCADO, 200)
  })

  return rota
}

/** O trabalho do pedido, depois da resposta: os freios, o aviso ao antigo, e o link ou o aviso de e-mail já usado. */
async function pedirATroca(
  dep: DependenciasDoEmail,
  conta: { readonly contaId: string; readonly nome: string; readonly email: string },
  novoEmail: string,
  site: string,
  agora: number,
): Promise<void> {
  const chave = resumirIp(conta.contaId, dep.sal)
  if (!(await dep.trava.travar(`troca-email:${chave}`, INTERVALO_DO_REENVIO_EM_SEGUNDOS))) {
    console.info(`conta ${conta.contaId}: troca de e-mail pedida antes dos 60 segundos, nada mandado`)
    return
  }
  if (!(await dep.limiteDoPedido.registrar(chave))) {
    console.info(`conta ${conta.contaId}: trocas de e-mail demais na hora, nada mandado`)
    return
  }

  if (!(await dep.carteiro.enviar(emailDeTrocaDeEmailPedida(conta.email, conta.nome, novoEmail)))) {
    console.error(`conta ${conta.contaId}: o aviso ao e-mail antigo não saiu`)
  }

  if (await dep.contas.existeComEmail(novoEmail)) {
    if (!(await dep.carteiro.enviar(emailDeEmailJaUsado(novoEmail, site)))) {
      console.error(`conta ${conta.contaId}: o aviso ao e-mail já usado não saiu`)
    }
    console.info(`conta ${conta.contaId}: troca para e-mail que já tem conta, o dono avisado`)
    return
  }

  const codigo = (dep.novoCodigo ?? codigoDeLink)()
  const troca = { resumoDoCodigo: resumirCodigo(codigo), valeAte: agora + PRAZO_DA_CONFIRMACAO_MS, novoEmail }
  /* Sem o pedido gravado, o link não conferiria: melhor não mandar. O adaptador já disse o código no log. */
  if (!(await dep.dados.gravarTrocaDeEmail(conta.contaId, troca))) return
  const link = linkDeTrocaDeEmail(site, conta.contaId, codigo)
  if (await dep.carteiro.enviar(emailDeTrocaDeEmail(novoEmail, conta.nome, link))) {
    console.info(`conta ${conta.contaId}: link da troca de e-mail mandado`)
  } else {
    console.error(`conta ${conta.contaId}: o link da troca de e-mail não saiu`)
  }
}
