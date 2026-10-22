/**
 * **`POST /conta`** — o cadastro (3.1; naveg-api-vercel#30, o PR 5).
 *
 * O corpo é o `CadastroDaConta` do domínio mais o desafio: nome, nascimento, e-mail, celular e senha. O documento
 * não está aqui: ele vem na primeira compra (PO, 2026-10-19). As conferências seguem a ordem do custo, como na
 * reserva, para o abuso parar cedo:
 *
 * 1. **a origem** → `403 ORIGEM_NAO_PERMITIDA`;
 * 2. **o cadastro ligado?** → `503 CADASTRO_INDISPONIVEL`;
 * 3. **o corpo** — até 4 kB, JSON, com os seis textos → `413`/`400 CORPO_INVALIDO`;
 * 4. **o limite por IP**, num contador só do cadastro → `429 LIMITE_EXCEDIDO`;
 * 5. **o desafio**, com a ação `cadastro` → `403 DESAFIO_INVALIDO`;
 * 6. **os campos**, pelo domínio (`pendenciasDoCadastro`), campo por campo → `422 CADASTRO_INVALIDO`;
 * 7. **a senha comum ou vazada** → `422 SENHA_FRACA`, com o motivo;
 * 8. **o e-mail**, a senha resumida e a gravação.
 *
 * ### A resposta não revela se o e-mail já tem conta
 *
 * PO, 2026-10-21: "Não revelar". O e-mail novo e o e-mail já usado recebem **a mesma resposta**, `202 { situacao:
 * 'CONFIRA_O_EMAIL' }`. A diferença vai pelo e-mail, que só o dono lê: o novo recebe o link de confirmação; o dono
 * da conta que já existe, o aviso de que alguém tentou criar outra (os dois no PR 6). Por isso o cadastro **não
 * entra na conta**: quem cria entra pelo link (3.2, C) ou pela senha (3.2, D).
 *
 * O tempo também não pode contar. Os dois caminhos pagam o scrypt da senha; o do e-mail novo grava, e o do já usado
 * vai mandar o aviso, no PR 6 — os dois com uma ida à rede.
 *
 * O log leva o id da conta, nunca o nome, o e-mail ou o celular.
 */
import { randomBytes } from 'node:crypto'

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import {
  contaNova,
  InstanteLocal,
  loteDaContaNova,
  normalizarEmail,
  pendenciasDoCadastro,
  type CadastroDaConta,
} from '@navegsistemas/domain'

import { motivoDaSenhaFraca } from '../conta/senha-fraca.js'
import { resumirSenha } from '../conta/senha.js'
import { ErroDaApi } from '../erros.js'
import type {
  ConsultaDeSenhaVazada,
  ContasDoCliente,
  LimitePorIp,
  Relogio,
  TravaPorChave,
  VerificadorDoDesafio,
} from '../portas.js'
import { ipDaRequisicao, resumirIp } from '../protecao/ip.js'
import { conferirOrigem } from '../protecao/origem.js'
import { FUSO_DA_OPERACAO } from './reservas.js'

export const LIMITE_DO_CORPO_DO_CADASTRO = 4 * 1024

/** A senha mais longa que se aceita. O scrypt aguenta mais; o teto só tira do caminho o corpo feito para pesar. */
export const SENHA_MAIS_LONGA = 128

/** Quanto tempo o mesmo e-mail fica travado depois de um cadastro: cobre o duplo toque e a rede lenta. */
export const TRAVA_DO_EMAIL_EM_SEGUNDOS = 30

export interface DependenciasDoCadastro {
  readonly contas: ContasDoCliente
  readonly desafio: VerificadorDoDesafio
  readonly limite: LimitePorIp
  readonly trava: TravaPorChave
  readonly senhaVazada: ConsultaDeSenhaVazada
  /** O sal dos resumos do IP e do e-mail — o mesmo segredo da reserva. */
  readonly sal: string
  /** O id da conta nova. Os cenários passam um fixo. */
  readonly novoId?: () => string
}

export interface ContextoDoCadastro {
  readonly origensPermitidas: readonly string[]
  readonly relogio: Relogio
  /** `null`: o cadastro não está configurado neste ambiente. */
  readonly cadastro: DependenciasDoCadastro | null
}

/** A resposta de todo cadastro aceito, com conta nova ou não. */
export const CONFIRA_O_EMAIL = { situacao: 'CONFIRA_O_EMAIL' } as const

/** 20 caracteres aleatórios, como o id que o próprio Firestore daria. */
export function idDeContaNova(): string {
  return randomBytes(15).toString('base64url')
}

const CAMPOS = ['nome', 'dataNascimento', 'email', 'telefone', 'senha', 'desafio'] as const

/** O corpo → o cadastro e o desafio, ou `null` quando falta um texto. O que vier a mais é ignorado. */
function cadastroDoJson(bruto: unknown): { cadastro: CadastroDaConta; desafio: string } | null {
  if (typeof bruto !== 'object' || bruto === null) return null
  const d = bruto as Record<string, unknown>
  if (!CAMPOS.every((campo) => typeof d[campo] === 'string')) return null
  const senha = d['senha'] as string
  if (senha.length > SENHA_MAIS_LONGA) return null
  return {
    cadastro: {
      nome: d['nome'] as string,
      dataNascimento: d['dataNascimento'] as string,
      email: d['email'] as string,
      telefone: d['telefone'] as string,
      senha,
    },
    desafio: d['desafio'] as string,
  }
}

export function rotaDaConta(contexto: ContextoDoCadastro): Hono {
  const rota = new Hono()

  rota.post(
    '/',
    async (c, proximo) => {
      /* 1 · a origem. */
      conferirOrigem(c.req.header('origin'), contexto.origensPermitidas)
      /* 2 · o cadastro ligado. */
      if (contexto.cadastro === null) {
        throw new ErroDaApi(503, 'CADASTRO_INDISPONIVEL', 'Cadastro de contas não configurado')
      }
      await proximo()
    },
    bodyLimit({
      maxSize: LIMITE_DO_CORPO_DO_CADASTRO,
      onError: () => {
        throw new ErroDaApi(413, 'CORPO_INVALIDO', 'Corpo grande demais')
      },
    }),
    async (c) => {
      const dep = contexto.cadastro as DependenciasDoCadastro

      /* 3 · o corpo. */
      let bruto: unknown
      try {
        bruto = await c.req.json()
      } catch {
        throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é JSON')
      }
      const pedido = cadastroDoJson(bruto)
      if (pedido === null) throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é um cadastro')

      /* 4 · o limite. */
      const ip = ipDaRequisicao((nome) => c.req.header(nome))
      if (!(await dep.limite.registrar(resumirIp(ip, dep.sal)))) {
        throw new ErroDaApi(429, 'LIMITE_EXCEDIDO', 'Cadastros demais deste endereço')
      }

      /* 5 · o desafio. */
      if (!(await dep.desafio.verificar(pedido.desafio, ip))) {
        throw new ErroDaApi(403, 'DESAFIO_INVALIDO', 'Desafio não confere')
      }

      /* 6 · os campos, como o site já conferiu — a API não confia nele. */
      const agora = contexto.relogio()
      const hoje = InstanteLocal.data(InstanteLocal.emFuso(agora, FUSO_DA_OPERACAO))
      const pendencias = pendenciasDoCadastro(pedido.cadastro, hoje)
      if (pendencias.size > 0) {
        throw new ErroDaApi(422, 'CADASTRO_INVALIDO', 'O cadastro tem campo errado', [...pendencias])
      }

      /* 7 · a senha comum ou vazada. */
      const motivo = await motivoDaSenhaFraca(pedido.cadastro.senha, dep.senhaVazada)
      if (motivo !== null) throw new ErroDaApi(422, 'SENHA_FRACA', 'A senha é comum ou vazada', [motivo])

      /* 8 · o e-mail. A trava vem antes da procura: sem ela, dois toques no botão achariam o e-mail livre, os dois. */
      const email = normalizarEmail(pedido.cadastro.email) as string
      const resumoDaSenha = await resumirSenha(pedido.cadastro.senha)
      const primeiro = await dep.trava.travar(resumirIp(email, dep.sal), TRAVA_DO_EMAIL_EM_SEGUNDOS)
      if (!primeiro || (await dep.contas.existeComEmail(email))) {
        /* O aviso ao dono do e-mail sai daqui, no PR 6. */
        console.info('cadastro com e-mail que já tem conta, ou repetido em seguida: nada gravado')
        return c.json(CONFIRA_O_EMAIL, 202)
      }

      const contaId = (dep.novoId ?? idDeContaNova)()
      const criadaEm = agora.getTime()
      const resultado = contaNova(contaId, pedido.cadastro, criadaEm, hoje)
      if (resultado.caso !== 'CONTA') {
        /* A conferência do passo 6 é a mesma do `contaNova`: chegar aqui é engano nosso. */
        console.error('cadastro sem pendência que o domínio não montou')
        throw new ErroDaApi(500, 'FALHA_INTERNA', 'Falha interna')
      }
      const gravada = await dep.contas.criar(
        contaId,
        loteDaContaNova(resultado.conta),
        { resumoDaSenha, geracao: 0, errosSeguidos: 0 },
        criadaEm,
      )
      if (!gravada) throw new ErroDaApi(500, 'FALHA_INTERNA', 'Falha interna')

      /* O link de confirmação sai daqui, no PR 6. */
      console.info(`conta ${contaId} criada`)
      return c.json(CONFIRA_O_EMAIL, 202)
    },
  )

  return rota
}
