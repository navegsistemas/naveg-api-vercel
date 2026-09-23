/**
 * **`POST /reservas`** — a reserva gravada, e a única escrita da API.
 *
 * O corpo é **só o que a pessoa pode afirmar**: a ocorrência, as respostas e o desafio. Todo o resto — a
 * embarcação, a partida, o código, o instante — é derivado aqui, do catálogo ao vivo e do relógio do servidor.
 * A ordem das conferências é a do custo, da mais barata à mais cara, para que o abuso pare cedo:
 *
 * 1. **a origem** — só o site da agência. Não é segurança sozinha (quem não é navegador manda a origem que
 *    quiser), mas tira o tráfego trivial de cima do resto → `403 ORIGEM_NAO_PERMITIDA`;
 * 2. **o envio está ligado?** Sem desafio e limite configurados, não há `POST` → `503 ENVIO_INDISPONIVEL`;
 * 3. **o corpo** — até 16 kB, JSON, na forma estrita do domínio → `413`/`400 CORPO_INVALIDO`;
 * 4. **o limite por IP** → `429 LIMITE_EXCEDIDO`;
 * 5. **o desafio**, conferido na Cloudflare → `403 DESAFIO_INVALIDO`;
 * 6. **a travessia**, procurada entre as **ofertadas agora** no catálogo recortado. Inativa, fora da concessão
 *    ou já partida → `409 TRAVESSIA_INDISPONIVEL`;
 * 7. **a montagem e a gravação** — o `enviarReserva` do domínio, o mesmo que o totem usava em memória, com a
 *    porta do Firestore. Incompleta ou incoerente → `422`, com as pendências tipadas.
 *
 * `201 { codigo, reserva }`: o código **do servidor**, e o documento como foi gravado — o totem o lê com o
 * mesmo codec que o aplicativo usa. Nada de outra reserva sai daqui, e o log leva o código, nunca o nome.
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import {
  enviarReserva,
  InstanteLocal,
  paraDocumento,
  pedidoDeReservaDoJson,
  recortarPelaConcessao,
  travessiasOfertadas,
  type ReservaCriadaJson,
  type ReservaRepositorio,
} from '@navegsistemas/domain'

import { ErroDaApi } from '../erros.js'
import type { LeitorDoCatalogo, LimitePorIp, Relogio, VerificadorDoDesafio } from '../portas.js'
import { ipDaRequisicao, resumirIp } from '../protecao/ip.js'

/**
 * O fuso da operação — o mesmo do totem (`conteudo/operacao.ts`, no front). Divergir aqui faria o servidor
 * achar que uma saída já partiu quando o totem ainda a oferta, e vice-versa.
 */
export const FUSO_DA_OPERACAO = 'America/Belem'

export const LIMITE_DO_CORPO = 16 * 1024

export interface DependenciasDoEnvio {
  readonly repositorio: ReservaRepositorio
  readonly desafio: VerificadorDoDesafio
  readonly limite: LimitePorIp
  /** O sal do resumo do IP. Segredo da implantação: sem ele, o resumo de um IP conhecido se refaz. */
  readonly salDoIp: string
}

export interface ContextoDaRota {
  readonly catalogo: LeitorDoCatalogo
  readonly origensPermitidas: readonly string[]
  /** A agência que registra a reserva — a NAVEG. Constante da implantação, nunca escolha de quem reserva. */
  readonly agenciaId: string
  readonly relogio: Relogio
  /** `null`: o envio não está configurado neste ambiente. */
  readonly envio: DependenciasDoEnvio | null
}

export function rotaDeReservas(contexto: ContextoDaRota): Hono {
  const rota = new Hono()

  rota.post(
    '/',
    async (c, proximo) => {
      /* 1 · a origem, antes de ler um byte do corpo. */
      const origem = c.req.header('origin')
      if (origem === undefined || !contexto.origensPermitidas.includes(origem)) {
        throw new ErroDaApi(403, 'ORIGEM_NAO_PERMITIDA', 'Origem não permitida')
      }
      /* 2 · o envio ligado. */
      if (contexto.envio === null) {
        throw new ErroDaApi(503, 'ENVIO_INDISPONIVEL', 'Envio de reservas não configurado')
      }
      await proximo()
    },
    bodyLimit({
      maxSize: LIMITE_DO_CORPO,
      onError: () => {
        throw new ErroDaApi(413, 'CORPO_INVALIDO', 'Corpo grande demais')
      },
    }),
    async (c) => {
      const envio = contexto.envio as DependenciasDoEnvio

      /* 3 · o corpo. */
      let bruto: unknown
      try {
        bruto = await c.req.json()
      } catch {
        throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é JSON')
      }
      const pedido = pedidoDeReservaDoJson(bruto)
      if (pedido === null) throw new ErroDaApi(400, 'CORPO_INVALIDO', 'O corpo não é um pedido de reserva')

      /* 4 · o limite. */
      const ip = ipDaRequisicao((nome) => c.req.header(nome))
      if (!(await envio.limite.registrar(resumirIp(ip, envio.salDoIp)))) {
        throw new ErroDaApi(429, 'LIMITE_EXCEDIDO', 'Envios demais deste endereço')
      }

      /* 5 · o desafio. */
      if (!(await envio.desafio.verificar(pedido.desafio, ip))) {
        throw new ErroDaApi(403, 'DESAFIO_INVALIDO', 'Desafio não confere')
      }

      /* 6 · a travessia, entre as ofertadas agora. */
      const catalogo = await contexto.catalogo.ler()
      if (catalogo.atuacao === null) {
        console.error('reserva recusada: a atuação AGENCIAMENTO da empresa configurada não existe')
        throw new ErroDaApi(500, 'FALHA_INTERNA', 'Falha interna')
      }
      const agora = InstanteLocal.emFuso(contexto.relogio(), FUSO_DA_OPERACAO)
      const id = `${pedido.ocorrencia.viagemId}@${pedido.ocorrencia.data}`
      const travessia = travessiasOfertadas(recortarPelaConcessao(catalogo), agora).find((t) => t.id === id)
      if (travessia === undefined) {
        throw new ErroDaApi(409, 'TRAVESSIA_INDISPONIVEL', 'A travessia não está sendo ofertada')
      }

      /* 7 · a montagem e a gravação. */
      const resultado = await enviarReserva({
        respostas: pedido.respostas,
        contexto: travessia.contexto,
        criadoEm: agora,
        repositorio: envio.repositorio,
        agenciaId: contexto.agenciaId,
      })
      switch (resultado.caso) {
        case 'ENVIADA': {
          console.info(`reserva ${resultado.reserva.codigo} gravada`)
          const corpo: ReservaCriadaJson = {
            codigo: resultado.reserva.codigo,
            reserva: paraDocumento(resultado.reserva),
          }
          return c.json(corpo, 201)
        }
        case 'INCOMPLETA':
          throw new ErroDaApi(422, 'RESERVA_INCOMPLETA', 'Faltam respostas')
        case 'INCOERENTE':
          throw new ErroDaApi(422, 'RESERVA_INCOERENTE', 'As respostas não formam uma reserva', [...resultado.pendencias])
        case 'FALHA':
          console.error(`reserva não gravada: ${resultado.motivo}`)
          throw new ErroDaApi(500, 'FALHA_INTERNA', 'Falha interna')
      }
    },
  )

  return rota
}
