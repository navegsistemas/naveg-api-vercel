/**
 * **A conta de serviço, conferida na partida** — e sem que o erro repita o segredo.
 *
 * Só a leitura do JSON é conferida aqui; o Admin SDK de verdade é do emulador. O que importa é o que acontece
 * quando a variável da Vercel está errada: a partida falha dizendo **o que** está errado, e nenhuma mensagem
 * carrega um pedaço da chave.
 */
import { describe, expect, it } from 'vitest'

import { ContaDeServicoInvalida, lerConta } from '../src/firestore/conexao.js'

const CHAVE = '-----BEGIN PRIVATE KEY-----\nSEGREDO-QUE-NAO-PODE-VAZAR\n-----END PRIVATE KEY-----\n'
const CONTA = {
  type: 'service_account',
  project_id: 'fluvi-app-dev',
  client_email: 'naveg-api-leitura@fluvi-app-dev.iam.gserviceaccount.com',
  private_key: CHAVE,
}

function falha(json: string, projeto = 'fluvi-app-dev'): ContaDeServicoInvalida {
  try {
    lerConta('leitura', json, projeto)
  } catch (erro) {
    if (erro instanceof ContaDeServicoInvalida) return erro
    throw erro
  }
  throw new Error('devia ter falhado')
}

describe('a conta de serviço', () => {
  it('lê o que o Admin SDK precisa', () => {
    expect(lerConta('leitura', JSON.stringify(CONTA), 'fluvi-app-dev')).toEqual({
      projectId: 'fluvi-app-dev',
      clientEmail: CONTA.client_email,
      privateKey: CHAVE,
    })
  })

  it('valor que não é JSON falha dizendo isso — e só isso', () => {
    const erro = falha(`${JSON.stringify(CONTA)}}}`)
    expect(erro.message).toContain('não é JSON')
    expect(erro.message).not.toContain('SEGREDO')
  })

  it('campo que falta é nomeado', () => {
    const { private_key: _, ...semChave } = CONTA
    expect(falha(JSON.stringify(semChave)).message).toContain('"private_key"')
  })

  it('conta de outro projeto falha na partida, em vez de ler o banco errado', () => {
    const erro = falha(JSON.stringify(CONTA), 'naveg-app-homol')
    expect(erro.message).toContain('fluvi-app-dev')
    expect(erro.message).toContain('naveg-app-homol')
    expect(erro.message).not.toContain('SEGREDO')
  })
})
