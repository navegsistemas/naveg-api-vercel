/**
 * **Quem entrou** — a conferência das rotas que pedem a sessão (Meus dados, 4.2), a mesma do `GET /conta/sessao`: a
 * assinatura e o prazo do cookie, a conta ativa e a geração (ADR-0003, seção 1).
 *
 * A conta e os segredos de acesso vêm numa leitura só, e voltam para a rota, que não lê de novo. O cookie que não
 * vale mais sai do aparelho (`401 SEM_SESSAO`); o que tem mais de um dia ganha um novo.
 */
import type { Context } from 'hono'

import { ErroDaApi } from '../erros.js'
import type { ContaDosMeusDados, DadosDaConta } from '../portas.js'
import {
  cabecalhoDaSessao,
  cabecalhoDeSaida,
  cookieDaSessao,
  lerSessao,
  precisaRenovar,
  valorDaSessao,
  type SegredosDaSessao,
} from './sessao.js'

export async function quemEntrou(
  c: Context,
  dados: DadosDaConta,
  segredos: SegredosDaSessao,
  agora: number,
): Promise<ContaDosMeusDados> {
  const valor = cookieDaSessao(c.req.header('cookie'))
  const sessao = valor === null ? null : lerSessao(valor, segredos, agora)
  const lida = sessao === null ? null : await dados.paraMeusDados(sessao.contaId)
  if (sessao === null || lida === null || !lida.conta.ativa || lida.acesso.geracao !== sessao.geracao) {
    if (valor !== null) c.header('Set-Cookie', cabecalhoDeSaida())
    throw new ErroDaApi(401, 'SEM_SESSAO', 'Ninguém entrou neste aparelho')
  }
  if (precisaRenovar(sessao, agora)) {
    const renovada = valorDaSessao({ contaId: sessao.contaId, emitidaEm: agora, geracao: sessao.geracao }, segredos)
    c.header('Set-Cookie', cabecalhoDaSessao(renovada))
  }
  return lida
}
