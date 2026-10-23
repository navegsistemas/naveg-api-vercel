/**
 * **Apagar a conta** — Meus dados (4.2, E; O7; naveg-api-vercel#30, o PR 10): "num passo próprio, com o que sai e o
 * que fica escrito antes e a senha para confirmar; vale na hora, a conta sai de todos os aparelhos e o documento fica
 * livre. As passagens ficam."
 *
 * **`POST /conta/apagar`** — `{ senha }`, **só para quem entrou** (`conta/quem-entrou.ts`). A senha é a confirmação,
 * conferida como nas trocas: o erro conta nas tentativas de entrar (`403 CREDENCIAIS_INVALIDAS`; o quinto, `429
 * TENTATIVAS_DEMAIS`). Certa:
 *
 * - **um lote só** (`apagarConta`): a conta e o índice do documento (o lote do domínio), os segredos todos e uma a
 *   menos no resumo. Sem os segredos, nenhum cookie e nenhum link da conta vale mais: **a conta sai de todos os
 *   aparelhos** sem precisar somar a geração;
 * - o cookie sai **deste** aparelho, e a resposta é `200 CONTA_APAGADA`;
 * - **o aviso "Sua conta foi apagada"**, com a hora, depois da resposta: se não foi a dona, ela fica sabendo.
 *
 * As passagens (quando a compra existir) não moram na conta, e ficam. O que o atendimento registrou no painel também.
 *
 * O log leva o id da conta, nunca o nome ou o e-mail.
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { emailDeContaApagada } from '../conta/emails.js'
import { quemEntrou } from '../conta/quem-entrou.js'
import { cabecalhoDeSaida, type SegredosDaSessao } from '../conta/sessao.js'
import { ErroDaApi } from '../erros.js'
import type { CarteiroDeEmail, ContasDoCliente, DadosDaConta, LimitePorIp, Relogio } from '../portas.js'
import { ipDaRequisicao, resumirIp } from '../protecao/ip.js'
import { conferirOrigem } from '../protecao/origem.js'
import { SENHA_MAIS_LONGA } from './conta.js'
import { conferirSenhaAtual, HORA_DO_AVISO } from './senha.js'

export const LIMITE_DO_CORPO_DO_APAGAR = 1024

/** A conta apagada. */
export const CONTA_APAGADA = { situacao: 'CONTA_APAGADA' } as const

export interface DependenciasDoApagar {
  /** O erro da senha. */
  readonly contas: ContasDoCliente
  /** A conta de quem entrou, e o lote que a apaga. */
  readonly dados: DadosDaConta
  readonly segredos: SegredosDaSessao
  /** O limite por IP: o mesmo contador do cadastro. */
  readonly limite: LimitePorIp
  readonly carteiro: CarteiroDeEmail
  /** O sal do resumo do IP. */
  readonly sal: string
  /** O que roda depois da resposta (o `waitUntil` da Vercel). Sem ele, a tarefa corre solta. */
  readonly emSegundoPlano?: (tarefa: Promise<void>) => void
}

export interface ContextoDoApagar {
  readonly origensPermitidas: readonly string[]
  readonly relogio: Relogio
  /** `null`: apagar a conta não está configurado neste ambiente. */
  readonly apagar: DependenciasDoApagar | null
}

export function rotaDoApagar(contexto: ContextoDoApagar): Hono {
  const rota = new Hono()

  rota.post(
    '/',
    async (c, proximo) => {
      conferirOrigem(c.req.header('origin'), contexto.origensPermitidas)
      /* Pede o que a troca de e-mail pede (o aviso sai, e a sessão): o mesmo código do cadastro. */
      if (contexto.apagar === null) throw new ErroDaApi(503, 'CADASTRO_INDISPONIVEL', 'Apagar a conta não configurado')
      await proximo()
    },
    bodyLimit({
      maxSize: LIMITE_DO_CORPO_DO_APAGAR,
      onError: () => {
        throw new ErroDaApi(413, 'CORPO_INVALIDO', 'Corpo grande demais')
      },
    }),
    async (c) => {
      const dep = contexto.apagar as DependenciasDoApagar

      let bruto: unknown
      try {
        bruto = await c.req.json()
      } catch {
        throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é JSON')
      }
      const { senha } = (typeof bruto === 'object' && bruto !== null ? bruto : {}) as Record<string, unknown>
      if (typeof senha !== 'string' || senha.length > SENHA_MAIS_LONGA) {
        throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é um pedido para apagar a conta')
      }

      const ip = ipDaRequisicao((nome) => c.req.header(nome))
      if (!(await dep.limite.registrar(resumirIp(ip, dep.sal)))) {
        throw new ErroDaApi(429, 'LIMITE_EXCEDIDO', 'Pedidos demais deste endereço')
      }

      const agora = contexto.relogio().getTime()
      const lida = await quemEntrou(c, dep.dados, dep.segredos, agora)
      await conferirSenhaAtual(dep.contas, lida, senha, agora)

      const { conta } = lida
      if (!(await dep.dados.apagarConta(conta))) throw new ErroDaApi(500, 'FALHA_INTERNA', 'Falha interna')
      console.info(`conta ${conta.id} apagada pela dona, em Meus dados`)
      c.header('Set-Cookie', cabecalhoDeSaida())

      const aviso = emailDeContaApagada(conta.email, conta.nome, HORA_DO_AVISO.format(new Date(agora)))
      const tarefa = dep.carteiro.enviar(aviso).then(
        (saiu) => {
          if (!saiu) console.error(`conta ${conta.id}: o aviso da conta apagada não saiu`)
        },
        (erro: unknown) => console.error(`conta ${conta.id}: o aviso da conta apagada não saiu: ${(erro as Error).message}`),
      )
      ;(dep.emSegundoPlano ?? ((solta) => void solta))(tarefa)
      return c.json(CONTA_APAGADA, 200)
    },
  )

  return rota
}
