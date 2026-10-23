/**
 * **Os códigos dos links** — a seção 3 da ADR-0003 (no `naveg-front`).
 *
 * Cada link (a confirmação do e-mail, 3.2; a troca de senha, 3.4) leva um código aleatório de 32 bytes, em
 * base64url. O e-mail leva o código; a API guarda **só o SHA-256 dele**, nos segredos da conta, com o prazo. Quem
 * copiar o banco não consegue usar os links.
 *
 * O código vai **depois do `#`** no endereço: `/conta/confirmar#<contaId>.<codigo>`. O que vem depois do `#` não
 * chega ao servidor no pedido da página, nem aos logs da Vercel, nem ao `Referer`; a página o manda à API num `POST`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** O link de confirmação vale 24 horas (3.2, B). */
export const PRAZO_DA_CONFIRMACAO_MS = 24 * 60 * 60 * 1000

/** Um código novo: 32 bytes aleatórios, em base64url (43 caracteres). */
export function codigoDeLink(): string {
  return randomBytes(32).toString('base64url')
}

/** O que se guarda do código: o SHA-256, em hexadecimal. */
export function resumirCodigo(codigo: string): string {
  return createHash('sha256').update(codigo, 'utf8').digest('hex')
}

/** O código confere com o resumo guardado? A comparação não diz, pelo tempo, quantos bytes acertaram. */
export function codigoConfere(codigo: string, resumoGuardado: string): boolean {
  const recebido = Buffer.from(resumirCodigo(codigo), 'hex')
  const guardado = Buffer.from(resumoGuardado, 'hex')
  return recebido.length === guardado.length && timingSafeEqual(recebido, guardado)
}

/** O endereço do link de confirmação, no site de onde veio o cadastro. */
export function linkDeConfirmacao(site: string, contaId: string, codigo: string): string {
  return `${site.replace(/\/$/, '')}/conta/confirmar#${contaId}.${codigo}`
}

/** O endereço do link da troca de e-mail (4.2, B), que vale 24 horas, como o de confirmação. */
export function linkDeTrocaDeEmail(site: string, contaId: string, codigo: string): string {
  return `${site.replace(/\/$/, '')}/conta/confirmar-email#${contaId}.${codigo}`
}

/** O link de troca de senha vale 1 hora, e uma vez só (3.4, A). */
export const PRAZO_DA_TROCA_MS = 60 * 60 * 1000

/** O endereço do link de troca de senha, no site de onde veio o pedido. */
export function linkDeTrocaDeSenha(site: string, contaId: string, codigo: string): string {
  return `${site.replace(/\/$/, '')}/conta/nova-senha#${contaId}.${codigo}`
}
