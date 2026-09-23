/**
 * **O token customizado** — a forma que o Firebase Auth aceita, e a assinatura que confere com a chave.
 *
 * E a trava do incidente de 2026-09-23: nada do código que vai para a Vercel carrega `firebase-admin/auth`.
 * Ele puxa o `jose` 6 por `require()`, o runtime da Vercel recusa, e a função cai inteira na partida — sem que
 * nenhum cenário local perceba, porque o Node daqui aceita.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { assinarTokenCustomizado, AUDIENCIA_DO_TOKEN } from '../src/firestore/token-customizado.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const CONTA = { clientEmail: 'naveg-api-escrita@fluvi-app-dev.iam.gserviceaccount.com', privateKey }

describe('o token customizado', () => {
  const token = assinarTokenCustomizado(CONTA, 'naveg-api', { papel: 'SERVICO', agenciaId: 'naveg' }, new Date('2026-09-23T20:00:00Z'))
  const [cabecalho, corpo, assinatura] = token.split('.') as [string, string, string]

  it('é um JWT RS256 com o que o Firebase pede, e vale uma hora', () => {
    expect(JSON.parse(Buffer.from(cabecalho, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const iat = Date.parse('2026-09-23T20:00:00Z') / 1000
    expect(JSON.parse(Buffer.from(corpo, 'base64url').toString())).toEqual({
      iss: CONTA.clientEmail,
      sub: CONTA.clientEmail,
      aud: AUDIENCIA_DO_TOKEN,
      iat,
      exp: iat + 3600,
      uid: 'naveg-api',
      claims: { papel: 'SERVICO', agenciaId: 'naveg' },
    })
  })

  it('a assinatura confere com a chave da conta', () => {
    const verificador = createVerify('RSA-SHA256').update(`${cabecalho}.${corpo}`)
    expect(verificador.verify(publicKey, Buffer.from(assinatura, 'base64url'))).toBe(true)
  })
})

describe('o que vai para a Vercel', () => {
  const RAIZ = fileURLToPath(new URL('..', import.meta.url))
  const fontes = (pasta: string): string[] =>
    readdirSync(pasta).flatMap((nome) => {
      const caminho = join(pasta, nome)
      return statSync(caminho).isDirectory() ? fontes(caminho) : nome.endsWith('.ts') ? [caminho] : []
    })

  it('não importa firebase-admin/auth — o runtime de lá não carrega o jose 6 por require()', () => {
    const arquivos = [...fontes(join(RAIZ, 'src')), ...fontes(join(RAIZ, 'api'))]
    expect(arquivos.length).toBeGreaterThan(5)
    for (const arquivo of arquivos) {
      const codigo = readFileSync(arquivo, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      expect(codigo, arquivo).not.toMatch(/from\s+['"]firebase-admin\/auth['"]/)
    }
  })
})
