/**
 * **Meus dados** — a 4.2 (naveg-api-vercel#30, o PR 9a): o que a conta mostra e o que a pessoa corrige sozinha.
 *
 * - **`GET /conta/dados`** — o nome, o e-mail, o celular, o nascimento, o documento **mascarado** (4.2, D; O12) ou
 *   `null` antes da primeira compra, e se o e-mail está confirmado. É o resumo de Minha conta (4.1, D) e a tela de
 *   Meus dados. Sem cache: é de uma pessoa só.
 * - **`POST /conta/dados`** — `{ nome, telefone }`, o "Salvar alterações" (4.2, A e F). O domínio confere os dois como
 *   no cadastro: `422 CADASTRO_INVALIDO`, com `NOME` ou `TELEFONE`. Aceito: `200`, com os dados como ficaram.
 *
 * O nascimento e o documento não mudam por aqui: só pelo atendimento, no painel (4.2, A; fluviapp-kmp#71, caso 7).
 * O e-mail e a senha têm cada um o seu passo (4.2, B e C), nos PRs seguintes.
 *
 * **Os dois pedem quem entrou** (`conta/quem-entrou.ts`), conferido como o `GET /conta/sessao` confere. O `POST`
 * confere a origem, como todo `POST` da conta.
 *
 * O log leva o id da conta, nunca o nome ou o celular.
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import {
  documentoMascarado,
  LIMITE_DO_NOME_DA_CONTA,
  normalizarNome,
  normalizarWhatsapp,
  type ContaDoCliente,
  type PendenciaDoCadastro,
} from '@navegsistemas/domain'

import { quemEntrou } from '../conta/quem-entrou.js'
import type { SegredosDaSessao } from '../conta/sessao.js'
import { ErroDaApi } from '../erros.js'
import type { DadosDaConta, Relogio } from '../portas.js'
import { conferirOrigem } from '../protecao/origem.js'

export const LIMITE_DO_CORPO_DOS_DADOS = 1024

export interface DependenciasDosDados {
  readonly dados: DadosDaConta
  readonly segredos: SegredosDaSessao
}

export interface ContextoDosDados {
  readonly origensPermitidas: readonly string[]
  readonly relogio: Relogio
  /** `null`: a sessão não está configurada neste ambiente. */
  readonly dados: DependenciasDosDados | null
}

/** O que a tela recebe. O documento inteiro não volta (O12). */
export interface MeusDados {
  readonly nome: string
  readonly email: string
  readonly telefone: string
  /** `AAAA-MM-DD`. */
  readonly dataNascimento: string
  /** O documento pela máscara do domínio ("CPF ###.###.789-09"), ou `null` antes da primeira compra. */
  readonly documento: string | null
  readonly confirmada: boolean
}

export function meusDados(conta: ContaDoCliente): MeusDados {
  return {
    nome: conta.nome,
    email: conta.email,
    telefone: conta.telefone,
    dataNascimento: conta.dataNascimento,
    documento: conta.documento === null ? null : documentoMascarado(conta.documento),
    confirmada: conta.confirmadaEm !== null,
  }
}

export function rotaDosDados(contexto: ContextoDosDados): Hono {
  const rota = new Hono()

  rota.get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (contexto.dados === null) throw new ErroDaApi(503, 'ENTRAR_INDISPONIVEL', 'Entrar não configurado')
    const dep = contexto.dados
    const { conta } = await quemEntrou(c, dep.dados, dep.segredos, contexto.relogio().getTime())
    return c.json(meusDados(conta), 200)
  })

  rota.post(
    '/',
    async (c, proximo) => {
      c.header('Cache-Control', 'no-store')
      conferirOrigem(c.req.header('origin'), contexto.origensPermitidas)
      if (contexto.dados === null) throw new ErroDaApi(503, 'ENTRAR_INDISPONIVEL', 'Entrar não configurado')
      await proximo()
    },
    bodyLimit({
      maxSize: LIMITE_DO_CORPO_DOS_DADOS,
      onError: () => {
        throw new ErroDaApi(413, 'CORPO_INVALIDO', 'Corpo grande demais')
      },
    }),
    async (c) => {
      const dep = contexto.dados as DependenciasDosDados

      let bruto: unknown
      try {
        bruto = await c.req.json()
      } catch {
        throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é JSON')
      }
      const { nome: nomeDigitado, telefone: telefoneDigitado } = (
        typeof bruto === 'object' && bruto !== null ? bruto : {}
      ) as Record<string, unknown>
      if (typeof nomeDigitado !== 'string' || typeof telefoneDigitado !== 'string') {
        throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não são os dados da conta')
      }

      const { conta } = await quemEntrou(c, dep.dados, dep.segredos, contexto.relogio().getTime())

      /* As mesmas conferências do cadastro, campo por campo: a tela erra embaixo do campo. */
      const nome = normalizarNome(nomeDigitado)
      const telefone = normalizarWhatsapp(telefoneDigitado)
      const pendencias: PendenciaDoCadastro[] = []
      if (nome.length === 0 || nome.length > LIMITE_DO_NOME_DA_CONTA) pendencias.push('NOME')
      if (telefone === null) pendencias.push('TELEFONE')
      if (pendencias.length > 0 || telefone === null) {
        throw new ErroDaApi(422, 'CADASTRO_INVALIDO', 'Os dados têm campo errado', pendencias)
      }

      /* Nada mudou (o "Salvar" tocado sem editar): nenhuma escrita. */
      if (nome !== conta.nome || telefone !== conta.telefone) {
        if (!(await dep.dados.salvarDados(conta.id, { nome, telefone }))) {
          throw new ErroDaApi(500, 'FALHA_INTERNA', 'Falha interna')
        }
        console.info(`conta ${conta.id}: nome e celular salvos`)
      }
      return c.json(meusDados({ ...conta, nome, telefone }), 200)
    },
  )

  return rota
}
