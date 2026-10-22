/**
 * **Entrar, sair e quem está dentro** — a 3.3 (naveg-api-vercel#30, o PR 7), com a sessão da ADR-0003.
 *
 * - **`POST /conta/entrar`** — e-mail, senha e o desafio do Turnstile (ação `entrar`). As conferências seguem a ordem
 *   do custo, como no cadastro: a origem, o corpo, o limite por IP, o desafio, e só então o banco e o scrypt.
 * - **`POST /conta/sair`** — apaga o cookie deste aparelho (3.3, D). Não precisa de banco.
 * - **`GET /conta/sessao`** — quem está dentro: `200 { situacao: 'DENTRO', confirmada }`, ou `401 SEM_SESSAO`. Confere
 *   a assinatura, o prazo, a conta ativa e a geração; renova o cookie que tem mais de um dia.
 *
 * ### O que a resposta não revela
 *
 * - **"E-mail ou senha não conferem"** (3.3, B): a mesma resposta, `401 CREDENCIAIS_INVALIDAS`, para o e-mail sem conta
 *   e para a senha errada. O e-mail sem conta paga o mesmo scrypt, contra um resumo fictício.
 * - **5 erros seguidos → 15 minutos** (3.3, C): a conta grava os erros nos segredos, e o quinto grava `bloqueadaAte`
 *   na conta, onde o painel vê e libera. O e-mail sem conta conta as tentativas num contador próprio, com o mesmo teto:
 *   os dois recebem `429 TENTATIVAS_DEMAIS` na quinta, e a espera não diz quem tem conta.
 * - **A conta desativada** (3.3, F): `403 CONTA_DESATIVADA`, **só depois da senha certa**.
 *
 * O log leva o id da conta, nunca o e-mail ou a senha.
 */
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { normalizarEmail } from '@navegsistemas/domain'

import { conferirSenha, resumoFicticio } from '../conta/senha.js'
import {
  cabecalhoDaSessao,
  cabecalhoDeSaida,
  cookieDaSessao,
  lerSessao,
  precisaRenovar,
  valorDaSessao,
  type SegredosDaSessao,
} from '../conta/sessao.js'
import { ErroDaApi } from '../erros.js'
import type { ContasDoCliente, LimitePorIp, Relogio, VerificadorDoDesafio } from '../portas.js'
import { ipDaRequisicao, resumirIp } from '../protecao/ip.js'
import { conferirOrigem } from '../protecao/origem.js'
import { SENHA_MAIS_LONGA } from './conta.js'

export const LIMITE_DO_CORPO_DO_ENTRAR = 2 * 1024

/** O quinto erro seguido espera (3.3, C). */
export const ERROS_ATE_ESPERAR = 5
export const ESPERA_DAS_TENTATIVAS_MS = 15 * 60 * 1000

export interface DependenciasDoEntrar {
  readonly contas: ContasDoCliente
  /** O desafio do Turnstile, com a ação `entrar`. */
  readonly desafio: VerificadorDoDesafio
  /** O limite por IP, num contador só do entrar. */
  readonly limite: LimitePorIp
  /** As tentativas por e-mail sem conta: o mesmo teto da conta, num contador de 15 minutos. */
  readonly limiteDoEmail: LimitePorIp
  readonly segredos: SegredosDaSessao
  /** O sal dos resumos do IP e do e-mail. */
  readonly sal: string
}

export interface ContextoDaSessao {
  readonly origensPermitidas: readonly string[]
  readonly relogio: Relogio
  /** `null`: entrar não está configurado neste ambiente. */
  readonly entrar: DependenciasDoEntrar | null
}

/** A resposta de quem está dentro: entrou agora, ou o cookie ainda vale. */
export function dentro(confirmada: boolean) {
  return { situacao: 'DENTRO', confirmada } as const
}

const CAMPOS = ['email', 'senha', 'desafio'] as const

function entradaDoJson(bruto: unknown): { email: string; senha: string; desafio: string } | null {
  if (typeof bruto !== 'object' || bruto === null) return null
  const d = bruto as Record<string, unknown>
  if (!CAMPOS.every((campo) => typeof d[campo] === 'string')) return null
  const senha = d['senha'] as string
  if (senha.length > SENHA_MAIS_LONGA) return null
  return { email: d['email'] as string, senha, desafio: d['desafio'] as string }
}

/** A sessão nova no cabeçalho da resposta. */
function abrirSessao(c: Context, contaId: string, geracao: number, agora: number, segredos: SegredosDaSessao): void {
  c.header('Set-Cookie', cabecalhoDaSessao(valorDaSessao({ contaId, emitidaEm: agora, geracao }, segredos)))
}

export function rotaDaSessao(contexto: ContextoDaSessao): Hono {
  const rota = new Hono()

  rota.post(
    '/entrar',
    async (c, proximo) => {
      conferirOrigem(c.req.header('origin'), contexto.origensPermitidas)
      if (contexto.entrar === null) throw new ErroDaApi(503, 'ENTRAR_INDISPONIVEL', 'Entrar não configurado')
      await proximo()
    },
    bodyLimit({
      maxSize: LIMITE_DO_CORPO_DO_ENTRAR,
      onError: () => {
        throw new ErroDaApi(413, 'CORPO_INVALIDO', 'Corpo grande demais')
      },
    }),
    async (c) => {
      const dep = contexto.entrar as DependenciasDoEntrar

      let bruto: unknown
      try {
        bruto = await c.req.json()
      } catch {
        throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é JSON')
      }
      const pedido = entradaDoJson(bruto)
      if (pedido === null) throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é uma entrada')

      const ip = ipDaRequisicao((nome) => c.req.header(nome))
      if (!(await dep.limite.registrar(resumirIp(ip, dep.sal)))) {
        throw new ErroDaApi(429, 'LIMITE_EXCEDIDO', 'Tentativas demais deste endereço')
      }
      if (!(await dep.desafio.verificar(pedido.desafio, ip))) {
        throw new ErroDaApi(403, 'DESAFIO_INVALIDO', 'Desafio não confere')
      }

      const agora = contexto.relogio().getTime()
      const email = normalizarEmail(pedido.email)
      const conta = email === null ? null : await dep.contas.paraEntrar(email)
      const naoConferem = new ErroDaApi(401, 'CREDENCIAIS_INVALIDAS', 'E-mail ou senha não conferem')
      const tentativasDemais = new ErroDaApi(429, 'TENTATIVAS_DEMAIS', 'Tentativas demais: espere 15 minutos')

      /* O e-mail sem conta: o mesmo scrypt, e o mesmo teto de tentativas, num contador próprio. */
      if (conta === null) {
        await conferirSenha(pedido.senha, await resumoFicticio())
        const chave = resumirIp(email ?? pedido.email.trim().toLowerCase(), dep.sal)
        if (!(await dep.limiteDoEmail.registrar(chave))) throw tentativasDemais
        throw naoConferem
      }

      /* Esperando: nem a senha certa entra. O scrypt é pago do mesmo jeito. */
      if (conta.bloqueadaAte !== null && agora < conta.bloqueadaAte) {
        await conferirSenha(pedido.senha, await resumoFicticio())
        throw tentativasDemais
      }

      if (!(await conferirSenha(pedido.senha, conta.acesso.resumoDaSenha))) {
        const erros = conta.acesso.errosSeguidos + 1
        if (erros >= ERROS_ATE_ESPERAR) {
          await dep.contas.registrarErroDeSenha(conta.contaId, 0, agora + ESPERA_DAS_TENTATIVAS_MS)
          console.info(`conta ${conta.contaId}: ${ERROS_ATE_ESPERAR} erros de senha seguidos, 15 minutos de espera`)
          throw tentativasDemais
        }
        await dep.contas.registrarErroDeSenha(conta.contaId, erros, null)
        throw naoConferem
      }

      if (!conta.ativa) throw new ErroDaApi(403, 'CONTA_DESATIVADA', 'Esta conta está desativada')

      if (conta.acesso.errosSeguidos > 0 || conta.bloqueadaAte !== null) {
        /* Sem zerar, a próxima senha errada esperaria antes da hora: o log diz, e a entrada segue. */
        await dep.contas.registrarEntrada(conta.contaId, conta.bloqueadaAte !== null)
      }
      abrirSessao(c, conta.contaId, conta.acesso.geracao, agora, dep.segredos)
      console.info(`conta ${conta.contaId} entrou`)
      return c.json(dentro(conta.confirmada), 200)
    },
  )

  rota.post('/sair', (c) => {
    conferirOrigem(c.req.header('origin'), contexto.origensPermitidas)
    c.header('Set-Cookie', cabecalhoDeSaida())
    return c.body(null, 204)
  })

  rota.get('/sessao', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (contexto.entrar === null) throw new ErroDaApi(503, 'ENTRAR_INDISPONIVEL', 'Entrar não configurado')
    const dep = contexto.entrar
    const agora = contexto.relogio().getTime()

    const valor = cookieDaSessao(c.req.header('cookie'))
    const sessao = valor === null ? null : lerSessao(valor, dep.segredos, agora)
    const conta = sessao === null ? null : await dep.contas.paraSessao(sessao.contaId)
    if (sessao === null || conta === null || !conta.ativa || conta.geracao !== sessao.geracao) {
      /* O cookie que não vale mais sai do aparelho. */
      if (valor !== null) c.header('Set-Cookie', cabecalhoDeSaida())
      throw new ErroDaApi(401, 'SEM_SESSAO', 'Ninguém entrou neste aparelho')
    }

    if (precisaRenovar(sessao, agora)) abrirSessao(c, sessao.contaId, sessao.geracao, agora, dep.segredos)
    return c.json(dentro(conta.confirmada), 200)
  })

  return rota
}
