/**
 * **O esqueleto** — a configuração que falha na partida, o CORS que só deixa a agência entrar, e a forma do
 * erro.
 *
 * O app é montado com uma configuração de teste: nenhum cenário depende de variável de ambiente, e é por isso
 * que eles rodam iguais na máquina de qualquer um e no CI.
 */
import { describe, expect, it } from 'vitest'

import { criarApp } from '../src/app.js'
import { ConfiguracaoIncompleta, lerConfig, type Config } from '../src/config.js'
import type { LeitorDoCatalogo } from '../src/portas.js'

const CONFIG: Config = {
  projetoFirebase: 'fluviapp-teste',
  contaDeLeitura: '{}',
  contaDeEscrita: '{}',
  empresaId: 'empresa-naveg',
  origensPermitidas: ['https://agencia.naveg.com.br', 'http://localhost:4321'],
}

const AMBIENTE_COMPLETO = {
  FIREBASE_PROJECT_ID: 'fluviapp-teste',
  FIREBASE_CONTA_DE_LEITURA: '{"a":1}',
  FIREBASE_CONTA_DE_ESCRITA: '{"a":2}',
  NAVEG_EMPRESA_ID: 'empresa-naveg',
  ORIGENS_PERMITIDAS: 'https://agencia.naveg.com.br/, http://localhost:4321',
}

describe('a configuração', () => {
  it('lê o ambiente completo, aparando a barra do fim das origens', () => {
    expect(lerConfig(AMBIENTE_COMPLETO)).toEqual({
      projetoFirebase: 'fluviapp-teste',
      contaDeLeitura: '{"a":1}',
      contaDeEscrita: '{"a":2}',
      empresaId: 'empresa-naveg',
      origensPermitidas: ['https://agencia.naveg.com.br', 'http://localhost:4321'],
    })
  })

  it('falha na partida dizendo **todas** as que faltam, e não só a primeira', () => {
    const { FIREBASE_CONTA_DE_ESCRITA: _, NAVEG_EMPRESA_ID: __, ...incompleto } = AMBIENTE_COMPLETO
    try {
      lerConfig(incompleto)
      throw new Error('devia ter falhado')
    } catch (erro) {
      expect(erro).toBeInstanceOf(ConfiguracaoIncompleta)
      expect((erro as ConfiguracaoIncompleta).faltando).toEqual(['FIREBASE_CONTA_DE_ESCRITA', 'NAVEG_EMPRESA_ID'])
    }
  })

  it('variável em branco conta como ausente — um segredo vazio não é um segredo', () => {
    expect(() => lerConfig({ ...AMBIENTE_COMPLETO, FIREBASE_CONTA_DE_LEITURA: '   ' })).toThrow(ConfiguracaoIncompleta)
  })
})

/** O esqueleto não lê catálogo; um leitor que falha denuncia se alguma rota daqui o chamar sem querer. */
const SEM_CATALOGO: LeitorDoCatalogo = {
  ler: () => Promise.reject(new Error('o esqueleto não devia ler o catálogo')),
}

describe('o app', () => {
  const app = criarApp({ config: CONFIG, catalogo: SEM_CATALOGO })

  it('responde a saúde sem falar com o Firestore', async () => {
    const resposta = await app.request('/saude')
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toEqual({ estado: 'ok' })
  })

  it('devolve a origem da agência no CORS, e nada para as outras', async () => {
    const daAgencia = await app.request('/saude', { headers: { Origin: 'https://agencia.naveg.com.br' } })
    expect(daAgencia.headers.get('access-control-allow-origin')).toBe('https://agencia.naveg.com.br')

    const deQualquerUm = await app.request('/saude', { headers: { Origin: 'https://outro-site.com' } })
    expect(deQualquerUm.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('rota que não existe é 404 com a forma de erro da API', async () => {
    const resposta = await app.request('/nao-existe')
    expect(resposta.status).toBe(404)
    expect(await resposta.json()).toEqual({ erro: 'CORPO_INVALIDO', mensagem: 'Rota inexistente' })
  })
})
