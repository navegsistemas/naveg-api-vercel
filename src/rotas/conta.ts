/**
 * **`POST /conta`** — o cadastro (3.1; naveg-api-vercel#30, o PR 5) —, **`POST /conta/confirmacao`**, o link do
 * e-mail (3.2; o PR 6), e **`POST /conta/confirmacao/reenvio`**, o "Reenviar" (3.2, B).
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
 * 8. **o e-mail**, a senha resumida, a gravação com o link de confirmação, e o e-mail.
 *
 * ### A resposta não revela se o e-mail já tem conta
 *
 * PO, 2026-10-21: "Não revelar". O e-mail novo e o e-mail já usado recebem **a mesma resposta**, `202 { situacao:
 * 'CONFIRA_O_EMAIL' }`. A diferença vai pelo e-mail, que só o dono lê: o novo recebe o link de confirmação; o dono
 * da conta que já existe, o aviso de que alguém tentou criar outra. Por isso o cadastro **não entra na conta**: quem
 * cria entra pelo link (3.2, C) ou pela senha (3.2, D).
 *
 * O tempo também não pode contar. Os dois caminhos pagam o scrypt da senha e mandam um e-mail; o do e-mail novo
 * grava antes. **Um e-mail que não sai não muda a resposta**: o erro vai ao log, e a conta, gravada, espera o
 * "Reenviar" (3.2, B), mais abaixo.
 *
 * O link leva ao site de onde veio o cadastro — a `Origin`, já conferida no passo 1.
 *
 * ### A confirmação
 *
 * O link é `/conta/confirmar#<contaId>.<codigo>`; a página manda os dois num `POST`. Respostas: `200 EMAIL_CONFIRMADO`;
 * `200 JA_CONFIRMADO` (o link aberto duas vezes); `410 LINK_VENCIDO` (passou das 24 horas); `410 LINK_INVALIDO`
 * (trocado por um mais novo, ou de conta que não existe). **Quem confirma fica dentro da conta** (3.2, C): a resposta
 * leva o cookie da sessão, quando o segredo dela está configurado e a conta está ativa.
 *
 * ### O "Reenviar"
 *
 * `POST /conta/confirmacao/reenvio`, com o e-mail (3.2, B): um link novo, de 24 horas, que **invalida o anterior**.
 * Vem da tela "Confira seu e-mail" e do link vencido, onde ninguém entrou ainda; por isso o pedido é pelo e-mail, e
 * não pela sessão. Os freios são por e-mail: **um a cada 60 segundos**, e **5 por hora**; e o limite por IP do
 * cadastro, antes deles.
 *
 * **A resposta é sempre `202 CONFIRA_O_EMAIL`**, como a do cadastro: e-mail sem conta, conta já confirmada, freio
 * puxado ou link mandado, tudo igual. O tempo também não pode contar, e aqui não há um e-mail para mandar nos dois
 * caminhos: o trabalho (os freios, a procura, a gravação e o e-mail) roda **depois da resposta**, no `waitUntil` da
 * Vercel. Os 60 segundos, quem mostra é a tela, com o botão esperando.
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

import {
  codigoConfere,
  codigoDeLink,
  linkDeConfirmacao,
  PRAZO_DA_CONFIRMACAO_MS,
  resumirCodigo,
} from '../conta/codigo.js'
import { emailDeCadastroRepetido, emailDeConfirmacao } from '../conta/emails.js'
import { cabecalhoDaSessao, valorDaSessao, type SegredosDaSessao } from '../conta/sessao.js'
import { motivoDaSenhaFraca } from '../conta/senha-fraca.js'
import { resumirSenha } from '../conta/senha.js'
import { ErroDaApi } from '../erros.js'
import type {
  CarteiroDeEmail,
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
  /** O e-mail do link de confirmação e o do aviso ao dono do e-mail já usado. */
  readonly carteiro: CarteiroDeEmail
  /** O sal dos resumos do IP e do e-mail — o mesmo segredo da reserva. */
  readonly sal: string
  /** O id da conta nova. Os cenários passam um fixo. */
  readonly novoId?: () => string
  /** O código do link. Os cenários passam um fixo. */
  readonly novoCodigo?: () => string
  /** Os segredos da sessão: com eles, quem confirma o e-mail já fica dentro da conta (3.2, C). */
  readonly segredosDaSessao?: SegredosDaSessao | null
  /** Os reenvios do link por e-mail, na hora (`LIMITE_DO_REENVIO`). A chave chega resumida, como o IP. */
  readonly limiteDoReenvio: LimitePorIp
  /**
   * O que roda depois da resposta: o `waitUntil` da Vercel, que segura a função até a tarefa acabar. Sem ele, a
   * tarefa corre solta. Os cenários guardam as tarefas e esperam por elas.
   */
  readonly emSegundoPlano?: (tarefa: Promise<void>) => void
}

/** O "Reenviar" a cada 60 segundos (3.2, B). */
export const INTERVALO_DO_REENVIO_EM_SEGUNDOS = 60

/** O limite por hora do "Reenviar" (3.2, B): cinco, para quem procurou no spam e pediu de novo, e não mais. */
export const LIMITE_DO_REENVIO = { teto: 5, janelaEmSegundos: 60 * 60 } as const

export const LIMITE_DO_CORPO_DO_REENVIO = 1024

/** O e-mail mais longo que a regra da conta aceita. */
const EMAIL_MAIS_LONGO = 254

/** A confirmação aceita, e o link aberto de novo depois dela. */
export const EMAIL_CONFIRMADO = { situacao: 'EMAIL_CONFIRMADO' } as const
export const JA_CONFIRMADO = { situacao: 'JA_CONFIRMADO' } as const

export const LIMITE_DO_CORPO_DA_CONFIRMACAO = 1024

/** O id da conta (20 caracteres base64url, `idDeContaNova`) e o código (43), como o link os leva. */
const ID_DA_CONTA = /^[A-Za-z0-9_-]{1,40}$/
const CODIGO = /^[A-Za-z0-9_-]{43}$/

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
      /* O site de onde veio o pedido, para os links: a `Origin`, já conferida no passo 1. */
      const site = c.req.header('origin') as string
      if (!(await dep.trava.travar(resumirIp(email, dep.sal), TRAVA_DO_EMAIL_EM_SEGUNDOS))) {
        /* O segundo toque no botão: o primeiro já cuida do e-mail, e um segundo e-mail só confundiria. */
        console.info('cadastro repetido em seguida: nada gravado')
        return c.json(CONFIRA_O_EMAIL, 202)
      }
      if (await dep.contas.existeComEmail(email)) {
        if (!(await dep.carteiro.enviar(emailDeCadastroRepetido(email, site)))) {
          console.error('o aviso de cadastro repetido não saiu')
        }
        console.info('cadastro com e-mail que já tem conta: nada gravado, o dono avisado')
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
      const codigo = (dep.novoCodigo ?? codigoDeLink)()
      const gravada = await dep.contas.criar(
        contaId,
        loteDaContaNova(resultado.conta),
        { resumoDaSenha, geracao: 0, errosSeguidos: 0 },
        { resumoDoCodigo: resumirCodigo(codigo), valeAte: criadaEm + PRAZO_DA_CONFIRMACAO_MS },
        criadaEm,
      )
      if (!gravada) throw new ErroDaApi(500, 'FALHA_INTERNA', 'Falha interna')
      console.info(`conta ${contaId} criada`)

      const link = linkDeConfirmacao(site, contaId, codigo)
      if (await dep.carteiro.enviar(emailDeConfirmacao(email, resultado.conta.nome, link))) {
        await dep.contas.registrarEnvio(contaId, 'CONFIRMACAO', criadaEm)
      } else {
        console.error(`conta ${contaId}: o link de confirmação não saiu`)
      }
      return c.json(CONFIRA_O_EMAIL, 202)
    },
  )

  /* A confirmação do e-mail: o link aberto (3.2). */
  rota.post(
    '/confirmacao',
    async (c, proximo) => {
      conferirOrigem(c.req.header('origin'), contexto.origensPermitidas)
      if (contexto.cadastro === null) {
        throw new ErroDaApi(503, 'CADASTRO_INDISPONIVEL', 'Cadastro de contas não configurado')
      }
      await proximo()
    },
    bodyLimit({
      maxSize: LIMITE_DO_CORPO_DA_CONFIRMACAO,
      onError: () => {
        throw new ErroDaApi(413, 'CORPO_INVALIDO', 'Corpo grande demais')
      },
    }),
    async (c) => {
      const dep = contexto.cadastro as DependenciasDoCadastro

      let bruto: unknown
      try {
        bruto = await c.req.json()
      } catch {
        throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é JSON')
      }
      const { contaId, codigo } = (typeof bruto === 'object' && bruto !== null ? bruto : {}) as Record<string, unknown>
      if (typeof contaId !== 'string' || !ID_DA_CONTA.test(contaId) || typeof codigo !== 'string' || !CODIGO.test(codigo)) {
        throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é uma confirmação')
      }

      /* O mesmo contador do cadastro: quem confirma acabou de se cadastrar, e o código de 32 bytes não se adivinha. */
      const ip = ipDaRequisicao((nome) => c.req.header(nome))
      if (!(await dep.limite.registrar(resumirIp(ip, dep.sal)))) {
        throw new ErroDaApi(429, 'LIMITE_EXCEDIDO', 'Pedidos demais deste endereço')
      }

      const conta = await dep.contas.paraConfirmar(contaId)
      if (conta === null) throw new ErroDaApi(410, 'LINK_INVALIDO', 'Este link não vale')
      /* Já confirmada: o link foi aberto de novo (o segundo toque, o e-mail aberto outra vez). */
      if (conta.confirmadaEm !== null) return c.json(JA_CONFIRMADO, 200)
      if (conta.confirmacao === null || !codigoConfere(codigo, conta.confirmacao.resumoDoCodigo)) {
        throw new ErroDaApi(410, 'LINK_INVALIDO', 'Este link não vale')
      }
      const agora = contexto.relogio().getTime()
      if (agora > conta.confirmacao.valeAte) throw new ErroDaApi(410, 'LINK_VENCIDO', 'Este link venceu')

      if (!(await dep.contas.confirmar(contaId, agora))) throw new ErroDaApi(500, 'FALHA_INTERNA', 'Falha interna')
      console.info(`conta ${contaId} confirmada`)
      /* Fica dentro da conta no aparelho em que abriu o link (3.2, C) — a desativada, não (3.3, F). */
      const segredos = dep.segredosDaSessao ?? null
      if (segredos !== null && conta.ativa) {
        const valor = valorDaSessao({ contaId, emitidaEm: agora, geracao: conta.geracao }, segredos)
        c.header('Set-Cookie', cabecalhoDaSessao(valor))
      }
      return c.json(EMAIL_CONFIRMADO, 200)
    },
  )

  /* O "Reenviar" (3.2, B): a resposta sai já; o resto, depois dela. */
  rota.post(
    '/confirmacao/reenvio',
    async (c, proximo) => {
      conferirOrigem(c.req.header('origin'), contexto.origensPermitidas)
      if (contexto.cadastro === null) {
        throw new ErroDaApi(503, 'CADASTRO_INDISPONIVEL', 'Cadastro de contas não configurado')
      }
      await proximo()
    },
    bodyLimit({
      maxSize: LIMITE_DO_CORPO_DO_REENVIO,
      onError: () => {
        throw new ErroDaApi(413, 'CORPO_INVALIDO', 'Corpo grande demais')
      },
    }),
    async (c) => {
      const dep = contexto.cadastro as DependenciasDoCadastro

      let bruto: unknown
      try {
        bruto = await c.req.json()
      } catch {
        throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é JSON')
      }
      const { email: digitado } = (typeof bruto === 'object' && bruto !== null ? bruto : {}) as Record<string, unknown>
      if (typeof digitado !== 'string' || digitado.length > EMAIL_MAIS_LONGO) {
        throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é um pedido de reenvio')
      }

      /* O mesmo contador do cadastro: quem pede o link de novo acabou de se cadastrar. */
      const ip = ipDaRequisicao((nome) => c.req.header(nome))
      if (!(await dep.limite.registrar(resumirIp(ip, dep.sal)))) {
        throw new ErroDaApi(429, 'LIMITE_EXCEDIDO', 'Pedidos demais deste endereço')
      }

      /* O e-mail que não tem a forma de um e-mail não tem conta: a mesma resposta, sem tarefa. */
      const email = normalizarEmail(digitado)
      if (email !== null) {
        const site = c.req.header('origin') as string
        const tarefa = reenviarOLink(dep, email, site, contexto.relogio().getTime()).catch((erro: unknown) => {
          console.error(`reenvio do link interrompido: ${(erro as Error).message}`)
        })
        ;(dep.emSegundoPlano ?? ((solta) => void solta))(tarefa)
      }
      return c.json(CONFIRA_O_EMAIL, 202)
    },
  )

  return rota
}

/**
 * O trabalho do "Reenviar", depois da resposta: os dois freios do e-mail, a conta, o link novo por cima do anterior,
 * e o e-mail. Tudo que não manda nada só deixa uma linha no log, sem o e-mail.
 */
async function reenviarOLink(dep: DependenciasDoCadastro, email: string, site: string, agora: number): Promise<void> {
  const chave = resumirIp(email, dep.sal)
  /* A trava antes do contador: o toque dentro dos 60 segundos não gasta um dos 5 da hora. */
  if (!(await dep.trava.travar(`reenvio:${chave}`, INTERVALO_DO_REENVIO_EM_SEGUNDOS))) {
    console.info('reenvio antes dos 60 segundos: nada mandado')
    return
  }
  if (!(await dep.limiteDoReenvio.registrar(chave))) {
    console.info('reenvios demais deste e-mail na hora: nada mandado')
    return
  }
  const conta = await dep.contas.paraReenviar(email)
  if (conta === null) {
    console.info('reenvio para e-mail sem conta: nada mandado')
    return
  }
  if (conta.confirmada) {
    console.info(`conta ${conta.contaId}: reenvio com o e-mail já confirmado, nada mandado`)
    return
  }
  const codigo = (dep.novoCodigo ?? codigoDeLink)()
  const confirmacao = { resumoDoCodigo: resumirCodigo(codigo), valeAte: agora + PRAZO_DA_CONFIRMACAO_MS }
  /* Sem o link novo gravado, o do e-mail não conferiria: melhor não mandar. O adaptador já disse o código no log. */
  if (!(await dep.contas.trocarConfirmacao(conta.contaId, confirmacao))) return
  const link = linkDeConfirmacao(site, conta.contaId, codigo)
  if (await dep.carteiro.enviar(emailDeConfirmacao(email, conta.nome, link))) {
    await dep.contas.registrarEnvio(conta.contaId, 'CONFIRMACAO', agora)
    console.info(`conta ${conta.contaId}: link de confirmação reenviado`)
  } else {
    console.error(`conta ${conta.contaId}: o link reenviado não saiu`)
  }
}
