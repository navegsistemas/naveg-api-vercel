/**
 * **A senha** — o resumo scrypt, a lista das comuns e a consulta por faixa ao Have I Been Pwned (ADR-0003, seção 2).
 */
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { motivoDaSenhaFraca, senhaComum, senhaVazadaNoHibp } from '../src/conta/senha-fraca.js'
import { conferirSenha, resumirSenha, type ParametrosDoScrypt } from '../src/conta/senha.js'
import type { Buscar } from '../src/protecao/turnstile.js'

/* Os cenários usam um custo baixo onde o custo não é o assunto: o padrão leva centenas de milissegundos. */
const BARATO: ParametrosDoScrypt = { custo: 10, blocos: 8, paralelismo: 1 }

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('o resumo scrypt', () => {
  it('o padrão é N = 2¹⁵, r = 8, p = 3, com o sal e o resumo no próprio texto', async () => {
    const resumo = await resumirSenha('rio e maré cheia')
    const partes = resumo.split('$')
    expect(partes.slice(0, 4)).toEqual(['scrypt', '15', '8', '3'])
    expect(Buffer.from(partes[4] as string, 'base64url')).toHaveLength(16)
    expect(Buffer.from(partes[5] as string, 'base64url')).toHaveLength(64)
  })

  it('confere a senha certa e recusa a errada', async () => {
    const resumo = await resumirSenha('rio e maré cheia', BARATO)
    expect(await conferirSenha('rio e maré cheia', resumo)).toBe(true)
    expect(await conferirSenha('rio e mare cheia', resumo)).toBe(false)
    expect(await conferirSenha('', resumo)).toBe(false)
  })

  it('a mesma senha dá resumos diferentes: cada um com o seu sal', async () => {
    expect(await resumirSenha('rio e maré cheia', BARATO)).not.toBe(await resumirSenha('rio e maré cheia', BARATO))
  })

  it('o resumo antigo, com outros parâmetros, continua conferindo', async () => {
    const antigo = await resumirSenha('rio e maré cheia', { custo: 11, blocos: 8, paralelismo: 2 })
    expect(await conferirSenha('rio e maré cheia', antigo)).toBe(true)
  })

  it('a mesma senha escrita com acento composto ou decomposto confere', async () => {
    const resumo = await resumirSenha('maré cheia', BARATO)
    expect(await conferirSenha('maré cheia', resumo)).toBe(true)
  })

  it('o resumo num formato desconhecido é "não"', async () => {
    expect(await conferirSenha('qualquer', 'bcrypt$2b$10$xyz')).toBe(false)
    expect(await conferirSenha('qualquer', 'scrypt$x$8$3$abc$def')).toBe(false)
  })
})

describe('a senha comum', () => {
  it('está na lista, sem diferença de maiúscula', () => {
    expect(senhaComum('12345678')).toBe(true)
    expect(senhaComum('Senha123')).toBe(true)
    expect(senhaComum('rio e maré cheia')).toBe(false)
  })
})

/** A resposta do Have I Been Pwned para uma faixa, com a senha dada dentro dela, ou não. */
function respostaDaFaixa(senha: string, vezes: number): { prefixo: string; corpo: string } {
  const sha1 = createHash('sha1').update(senha).digest('hex').toUpperCase()
  const linhas = ['0018A45C4D1DEF81644B54AB7F969B88D65:1', `${sha1.slice(5)}:${vezes}`, 'FFFFF45C4D1DEF81644B54AB7F969B88D65:3']
  return { prefixo: sha1.slice(0, 5), corpo: linhas.join('\r\n') }
}

describe('a senha vazada, pela faixa', () => {
  it('manda só os 5 primeiros caracteres do SHA-1, com o preenchimento, e acha o resto na resposta', async () => {
    const { prefixo, corpo } = respostaDaFaixa('rio e maré cheia', 42)
    const chamadas: { url: string; init: RequestInit | undefined }[] = []
    const buscar: Buscar = async (url, init) => {
      chamadas.push({ url, init })
      return new Response(corpo)
    }
    expect(await senhaVazadaNoHibp(buscar).vazada('rio e maré cheia')).toBe(true)
    expect(chamadas[0]?.url).toBe(`https://api.pwnedpasswords.com/range/${prefixo}`)
    expect(new Headers(chamadas[0]?.init?.headers).get('Add-Padding')).toBe('true')
    expect(JSON.stringify(chamadas)).not.toContain('rio e maré')
  })

  it('o final com zero ocorrências é o preenchimento, e não conta', async () => {
    const { corpo } = respostaDaFaixa('rio e maré cheia', 0)
    expect(await senhaVazadaNoHibp(async () => new Response(corpo)).vazada('rio e maré cheia')).toBe(false)
  })

  it('a senha fora da faixa não está vazada', async () => {
    const { corpo } = respostaDaFaixa('outra senha qualquer', 7)
    expect(await senhaVazadaNoHibp(async () => new Response(corpo)).vazada('rio e maré cheia')).toBe(false)
  })

  it('a rede que falha, ou responde erro, vale como "não vazada": fica a lista', async () => {
    const falha: Buscar = async () => Promise.reject(new Error('sem rede'))
    expect(await senhaVazadaNoHibp(falha).vazada('rio e maré cheia')).toBe(false)
    expect(await senhaVazadaNoHibp(async () => new Response('', { status: 503 })).vazada('x')).toBe(false)
  })

  it('a consulta que demora mais que o prazo é abandonada', async () => {
    const lenta: Buscar = (_url, init) =>
      new Promise((_resolver, rejeitar) => init?.signal?.addEventListener('abort', () => rejeitar(new Error('tempo'))))
    expect(await senhaVazadaNoHibp(lenta, 20).vazada('rio e maré cheia')).toBe(false)
  })
})

describe('o motivo da senha fraca', () => {
  it('a comum primeiro, sem consultar; depois a vazada; senão, nenhum', async () => {
    const consultas: string[] = []
    const consulta = { vazada: async (s: string) => (consultas.push(s), s === 'vazou muito') }
    expect(await motivoDaSenhaFraca('12345678', consulta)).toBe('SENHA_COMUM')
    expect(consultas).toHaveLength(0)
    expect(await motivoDaSenhaFraca('vazou muito', consulta)).toBe('SENHA_VAZADA')
    expect(await motivoDaSenhaFraca('rio e maré cheia', consulta)).toBeNull()
  })
})
