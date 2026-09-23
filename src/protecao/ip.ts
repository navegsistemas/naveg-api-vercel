/**
 * **O IP de quem pede, e o resumo dele.**
 *
 * Na Vercel, o endereço de quem chamou vem em `x-real-ip` (e é o primeiro de `x-forwarded-for`); a plataforma
 * os escreve, e quem chama não consegue forjá-los por cima dela. Fora da Vercel — nos cenários, no `vercel
 * dev` — pode não haver nenhum, e o pedido cai num balde só, `sem-ip`.
 *
 * O IP é dado pessoal (LGPD). Ele vai **inteiro** só para a Cloudflare, que precisa dele para conferir o
 * desafio; para o contador do limite vai **resumido** — um SHA-256 com um sal da implantação —, que serve para
 * contar e não serve para saber de quem é.
 */
import { createHash } from 'node:crypto'

export function ipDaRequisicao(cabecalho: (nome: string) => string | undefined): string {
  const real = cabecalho('x-real-ip')?.trim()
  if (real !== undefined && real.length > 0) return real
  const primeiro = cabecalho('x-forwarded-for')?.split(',')[0]?.trim()
  return primeiro !== undefined && primeiro.length > 0 ? primeiro : 'sem-ip'
}

export function resumirIp(ip: string, sal: string): string {
  return createHash('sha256').update(`${sal}:${ip}`).digest('hex').slice(0, 32)
}
