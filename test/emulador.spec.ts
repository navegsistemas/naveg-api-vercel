/**
 * **A gravação de ponta a ponta** — o SDK de verdade, o emulador de verdade, e as Rules do fluviapp-kmp.
 *
 * Os outros cenários usam portas falsas; este é o que prova que a peça inteira encaixa: o assinador daqui emite
 * o token com as *claims* do serviço, o SDK cliente entra com ele, e a transação grava reserva e evento **sob as
 * Rules** — que aceitam o que é da agência do token e recusam o resto.
 *
 * Roda com `npm run test:emulador` (ver `scripts/emulador.mjs`). Sem o emulador no ambiente, aparece pulado.
 */
import { initializeApp as iniciarAdmin } from 'firebase-admin/app'
import { generateKeyPairSync } from 'node:crypto'

import { getFirestore as firestoreDoAdmin } from 'firebase-admin/firestore'
import { initializeApp as iniciarCliente } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInWithCustomToken } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'
import { describe, expect, it } from 'vitest'

import { DataCalendario, InstanteLocal, montarEncomenda, montarReserva, type Reserva, type RespostasDaEncomenda } from '@navegsistemas/domain'

import { loteNoFirestore, reservaNoFirestore } from '../src/firestore/reserva-firestore.js'
import { sessaoDoServico, UID_DO_SERVICO } from '../src/firestore/servico.js'
import { assinarTokenCustomizado } from '../src/firestore/token-customizado.js'

const FIRESTORE = process.env['FIRESTORE_EMULATOR_HOST']
const AUTH = process.env['FIREBASE_AUTH_EMULATOR_HOST']
const EMULADOR = FIRESTORE !== undefined && AUTH !== undefined
const PROJETO = 'demo-fluviapp'
const AGENCIA = 'empresa-naveg'

/* Desde o fluviapp-kmp#44 (ADR-0019 de lá), a regra de `reservas` confere a saída: a viagem existe e está ativa,
   a data cai no dia da semana dela, entre hoje em Belém (UTC−3) e o fim do alcance (encomenda, 7 dias), e não
   está suspensa. Por isso a data é contada a partir de hoje, e a viagem é gravada antes, pelo admin. */
function diasDepoisDeHoje(dias: number): Date {
  const hojeEmBelem = new Date(Date.now() - 3 * 3_600_000)
  return new Date(Date.UTC(hojeEmBelem.getUTCFullYear(), hojeEmBelem.getUTCMonth(), hojeEmBelem.getUTCDate() + dias))
}
const DIAS_DA_SEMANA = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const
const SAIDA = diasDepoisDeHoje(3)
const DATA = SAIDA.toISOString().slice(0, 10)
const VESPERA = diasDepoisDeHoje(2).toISOString().slice(0, 10)
const VIAGEM = { ativo: true, diaSemana: DIAS_DA_SEMANA[SAIDA.getUTCDay()] }

const saida = (viagemId = 'v') => ({
  ocorrencia: { viagemId, data: DataCalendario.de(DATA) as DataCalendario },
  tipoEmbarcacao: 'FERRY_BOAT' as const,
  partida: InstanteLocal.de(`${DATA}T18:00`) as InstanteLocal,
})

function reserva(codigo: string, agenciaId = AGENCIA, viagemId = 'v'): Reserva {
  const montagem = montarReserva(
    { categoria: 'PASSAGEIRO', acomodacao: 'REDE', tipo: 'INTEIRA', cliente: { nome: 'Maria' } },
    saida(viagemId),
    { codigo, criadoEm: InstanteLocal.de(`${VESPERA}T08:00`) as InstanteLocal },
  )
  if (montagem.caso !== 'OK') throw new Error('exemplo incoerente')
  return { ...montagem.reserva, agenciaId }
}

/** A reserva de encomenda, montada pelo domínio — a que a regra de `reservas` do KMP passou a aceitar. */
function encomenda(codigo: string, respostas: RespostasDaEncomenda): Reserva {
  const montagem = montarEncomenda(
    respostas,
    saida(),
    { codigo, criadoEm: InstanteLocal.de(`${VESPERA}T08:00`) as InstanteLocal, agenciaId: AGENCIA },
  )
  if (montagem.caso !== 'OK') throw new Error('exemplo incoerente')
  return montagem.reserva
}

describe.skipIf(!EMULADOR)(`ponta a ponta, no emulador${EMULADOR ? '' : ' — PULADO: sem emulador (npm run test:emulador)'}`, () => {
  it('grava reserva e evento pelo token de serviço, recusa o código em uso, as Rules recusam outra agência, e a encomenda passa', async () => {
    const admin = iniciarAdmin({ projectId: PROJETO }, 'admin-do-emulador')
    const cliente = iniciarCliente({ apiKey: 'chave-do-emulador', projectId: PROJETO }, 'cliente-do-emulador')
    connectAuthEmulator(getAuth(cliente), `http://${AUTH}`, { disableWarnings: true })
    const db = getFirestore(cliente)
    const [host, porta] = (FIRESTORE as string).split(':')
    connectFirestoreEmulator(db, host as string, Number(porta))

    /* O assinador de produção, com uma chave qualquer: o emulador do Auth não confere a assinatura. */
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const conta = { clientEmail: `naveg-api-escrita@${PROJETO}.iam.gserviceaccount.com`, privateKey }
    const obter = sessaoDoServico(AGENCIA, {
      emitirToken: async (uid, claims) => assinarTokenCustomizado(conta, uid, { ...claims }),
      entrar: async (token) => {
        await signInWithCustomToken(getAuth(cliente), token)
        return db
      },
    })
    const repositorio = reservaNoFirestore(loteNoFirestore(obter), UID_DO_SERVICO)
    const banco = firestoreDoAdmin(admin)
    await banco.doc('viagens/v').set(VIAGEM)
    await banco.doc('viagens/v-suspensa').set(VIAGEM)
    await banco.doc(`suspensoes/v-suspensa@${DATA}`).set({ viagemId: 'v-suspensa', data: DATA, motivo: 'docagem' })

    expect(await repositorio.criar(reserva('NVG-7K3QP2'))).toEqual({ caso: 'GRAVADA' })
    expect((await banco.doc('reservas/NVG-7K3QP2').get()).data()).toMatchObject({ status: 'RESERVADA', agenciaId: AGENCIA })
    expect((await banco.doc('eventos/reserva.criada:NVG-7K3QP2').get()).data()).toMatchObject({ porId: 'naveg-api' })

    expect(await repositorio.criar(reserva('NVG-7K3QP2'))).toEqual({ caso: 'CODIGO_EM_USO' })

    /* O domínio nunca montaria isto — mas, se montasse, as Rules seguram. É o que a P3 comprou. E é também a
       prova de que o emulador subiu **com** as Rules: sem elas, ele aceita tudo, e este passo falha. */
    expect((await repositorio.criar(reserva('NVG-7K3QP3', 'outra-agencia'))).caso).toBe('FALHA')
    expect((await banco.doc('reservas/NVG-7K3QP3').get()).exists).toBe(false)

    /* A saída suspensa e a viagem que não existe: a regra recusa (fluviapp-kmp#44). A rota recusa antes, com 409
       e a mensagem (`reservas.spec.ts`); aqui, sem a rota, é a regra que segura — o piso que vale com a API errada. */
    expect((await repositorio.criar(reserva('NVG-7K3QP4', AGENCIA, 'v-suspensa'))).caso).toBe('FALHA')
    expect((await banco.doc('reservas/NVG-7K3QP4').get()).exists).toBe(false)
    expect((await repositorio.criar(reserva('NVG-7K3QP5', AGENCIA, 'nao-existe'))).caso).toBe('FALHA')
    expect((await banco.doc('reservas/NVG-7K3QP5').get()).exists).toBe(false)

    /* Pelo site (naveg-front#65): sete numa suíte, sem o tipo. As Rules do KMP não mudaram (PO, 2026-10-14) — e
       aceitam: `formaDoPedido` não exige o tipo nem limita a quantidade pela acomodação. */
    const doSite = montarReserva(
      { canal: 'SITE', categoria: 'PASSAGEIRO', quantidadePessoas: 7, acomodacao: 'SUITE', cliente: { nome: 'Maria' } },
      saida(),
      { codigo: 'NVG-5ATE07', criadoEm: InstanteLocal.de(`${VESPERA}T08:00`) as InstanteLocal, agenciaId: AGENCIA },
    )
    if (doSite.caso !== 'OK') throw new Error('exemplo incoerente')
    expect(await repositorio.criar(doSite.reserva)).toEqual({ caso: 'GRAVADA' })
    const gravada = (await banco.doc('reservas/NVG-5ATE07').get()).data()
    expect(gravada).toMatchObject({ acomodacao: 'SUITE', quantidadePessoas: 7 })
    expect(gravada).not.toHaveProperty('tipo')

    /* A encomenda (entrega 3 do MVP): as duas formas de retirada passam pelas Rules do KMP, com o evento. */
    const paraOutra = encomenda('NVG-ENC0M1', {
      tipoVolume: 'CAIXA',
      quantidadeVolumes: 3,
      complemento: 'mantimentos',
      faixaPeso: 'DE_5_A_20',
      retirada: 'OUTRA_PESSOA',
      destinatario: { nome: 'João Lima', telefone: '(96) 98888-7777' },
      cliente: { nome: 'Maria' },
    })
    expect(await repositorio.criar(paraOutra)).toEqual({ caso: 'GRAVADA' })
    expect((await banco.doc('reservas/NVG-ENC0M1').get()).data()).toMatchObject({
      categoria: 'ENCOMENDA',
      destinatario: { nome: 'João Lima', telefone: '5596988887777' },
    })
    expect((await banco.doc('eventos/reserva.criada:NVG-ENC0M1').get()).exists).toBe(true)

    const doProprio = encomenda('NVG-ENC0M2', {
      tipoVolume: 'SACO_FARDO',
      quantidadeVolumes: 1,
      faixaPeso: 'ATE_5',
      retirada: 'REMETENTE',
      cliente: { nome: 'Carlos', telefone: '(91) 98888-1234' },
    })
    expect(await repositorio.criar(doProprio)).toEqual({ caso: 'GRAVADA' })

    /* E o que o domínio não monta, as Rules também recusam: quem manda e retira, sem celular. */
    expect((await repositorio.criar({ ...doProprio, codigo: 'NVG-ENC0M3', cliente: { nome: 'Carlos' } })).caso).toBe('FALHA')
    expect((await banco.doc('reservas/NVG-ENC0M3').get()).exists).toBe(false)
  }, 30_000)
})
