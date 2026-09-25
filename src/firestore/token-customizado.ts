/**
 * **O token customizado, assinado aqui** — sem o `firebase-admin/auth`.
 *
 * O `createCustomToken` do Admin SDK faria o mesmo, mas carregar `firebase-admin/auth` puxa o `jwks-rsa` 4, que
 * faz `require()` do `jose` 6 — um pacote só-ESM. O Node desta máquina aceita; **o runtime da Vercel não**, e a
 * função inteira caiu na partida, até o `/saude` (2026-09-23, `ERR_REQUIRE_ESM`). Nenhum cenário local pegaria.
 * `test/token-customizado.spec.ts` impede o import de voltar.
 *
 * O token é o JWT RS256 que o Firebase documenta para "criar tokens com uma biblioteca JWT": emissor e sujeito
 * são a conta de serviço, a audiência é o Identity Toolkit, vale no máximo uma hora, e leva o `uid` e as
 * *claims*. A assinatura é a chave privada da conta — por isso emiti-lo não pede papel de IAM nenhum.
 */
import { createSign } from 'node:crypto'

export const AUDIENCIA_DO_TOKEN =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit'

/** Uma hora é o máximo que o Firebase aceita — e o token só é trocado por sessão uma vez. */
const VALIDADE_EM_SEGUNDOS = 60 * 60

export interface ContaQueAssina {
  readonly clientEmail: string
  readonly privateKey: string
}

function base64url(dado: string | Buffer): string {
  return Buffer.from(dado).toString('base64url')
}

export function assinarTokenCustomizado(
  conta: ContaQueAssina,
  uid: string,
  claims: Readonly<Record<string, string>>,
  agora: Date = new Date(),
): string {
  const iat = Math.floor(agora.getTime() / 1000)
  const cabecalho = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const corpo = base64url(
    JSON.stringify({
      iss: conta.clientEmail,
      sub: conta.clientEmail,
      aud: AUDIENCIA_DO_TOKEN,
      iat,
      exp: iat + VALIDADE_EM_SEGUNDOS,
      uid,
      claims,
    }),
  )
  const assinatura = createSign('RSA-SHA256').update(`${cabecalho}.${corpo}`).sign(conta.privateKey)
  return `${cabecalho}.${corpo}.${base64url(assinatura)}`
}
