/**
 * **A sessão: um cookie do site, assinado pela API** — a seção 1 da ADR-0003 (no `naveg-front`).
 *
 * ```
 * __Host-sessao=v1.<contaId>.<emitidaEm>.<geracao>.<assinatura>
 * Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1209600
 * ```
 *
 * - **`__Host-`**: o navegador só aceita o cookie com `Secure`, `Path=/` e sem `Domain` — preso ao endereço exato do
 *   site. Como a API responde pelo `/api` do site, o cookie é do próprio site;
 * - **`HttpOnly`**: o JavaScript da página não o lê;
 * - **14 dias, renovados** quando o cookie tem mais de um dia (PO, 2026-10-21: "alinhe as sessões em 14");
 * - **a assinatura** é um HMAC-SHA256 de tudo o que vem antes dela, com o `SEGREDO_DA_SESSAO`. O segredo anterior
 *   também confere, para a troca do segredo não tirar todo mundo da conta;
 * - **a `geracao`** vem dos segredos da conta: somar 1 lá tira a conta de todos os aparelhos. Quem confere é a rota,
 *   que lê a conta; aqui só se lê o número.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

import type { SegredosDaSessao } from '../config.js'

export type { SegredosDaSessao }

export const NOME_DO_COOKIE = '__Host-sessao'
export const VERSAO_DO_COOKIE = 'v1'

/** 14 dias, em milissegundos. */
export const DURACAO_DA_SESSAO_MS = 14 * 24 * 60 * 60 * 1000

/** Depois de um dia, a resposta leva um cookie novo — e não a cada pedido. */
export const RENOVAR_DEPOIS_DE_MS = 24 * 60 * 60 * 1000

export interface Sessao {
  readonly contaId: string
  readonly emitidaEm: number
  readonly geracao: number
}

function assinar(texto: string, segredo: string): string {
  return createHmac('sha256', segredo).update(texto, 'utf8').digest('base64url')
}

/** O valor do cookie de uma sessão nova. */
export function valorDaSessao(sessao: Sessao, segredos: SegredosDaSessao): string {
  const texto = [VERSAO_DO_COOKIE, sessao.contaId, String(sessao.emitidaEm), String(sessao.geracao)].join('.')
  return `${texto}.${assinar(texto, segredos.atual)}`
}

/**
 * O valor do cookie → a sessão, ou `null` quando ele não confere: outra versão, a assinatura errada (de nenhum dos
 * dois segredos), ou vencido. O id da conta tem a forma do `idDeContaNova`, sem ponto.
 */
export function lerSessao(valor: string, segredos: SegredosDaSessao, agora: number): Sessao | null {
  const partes = valor.split('.')
  if (partes.length !== 5 || partes[0] !== VERSAO_DO_COOKIE) return null
  const [, contaId, emitida, geracao, assinatura] = partes as [string, string, string, string, string]
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(contaId) || !/^\d{1,15}$/.test(emitida) || !/^\d{1,9}$/.test(geracao)) return null

  const texto = partes.slice(0, 4).join('.')
  const recebida = Buffer.from(assinatura, 'base64url')
  const confere = [segredos.atual, segredos.anterior]
    .filter((segredo): segredo is string => segredo !== null)
    .some((segredo) => {
      const esperada = Buffer.from(assinar(texto, segredo), 'base64url')
      return esperada.length === recebida.length && timingSafeEqual(esperada, recebida)
    })
  if (!confere) return null

  const emitidaEm = Number(emitida)
  if (emitidaEm > agora || agora - emitidaEm > DURACAO_DA_SESSAO_MS) return null
  return { contaId, emitidaEm, geracao: Number(geracao) }
}

/** O `Set-Cookie` de uma sessão nova. */
export function cabecalhoDaSessao(valor: string): string {
  return `${NOME_DO_COOKIE}=${valor}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${DURACAO_DA_SESSAO_MS / 1000}`
}

/** O `Set-Cookie` que apaga o cookie deste aparelho (sair, ou a sessão que não vale mais). */
export function cabecalhoDeSaida(): string {
  return `${NOME_DO_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`
}

/** O valor do cookie da sessão no cabeçalho `Cookie`, ou `null`. */
export function cookieDaSessao(cabecalho: string | undefined): string | null {
  if (cabecalho === undefined) return null
  for (const parte of cabecalho.split(';')) {
    const [nome, ...resto] = parte.trim().split('=')
    if (nome === NOME_DO_COOKIE) return resto.join('=')
  }
  return null
}

/** O cookie tem mais de um dia? Então a resposta leva um novo, com o prazo de 14 dias contado de agora. */
export function precisaRenovar(sessao: Sessao, agora: number): boolean {
  return agora - sessao.emitidaEm > RENOVAR_DEPOIS_DE_MS
}
