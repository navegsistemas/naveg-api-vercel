/**
 * **A gravação de ponta a ponta** — o SDK de verdade, o emulador de verdade, e as Rules do fluviapp-kmp.
 *
 * Os outros cenários usam portas falsas; este é o que prova que a peça inteira encaixa: o Admin SDK emite o
 * token com as *claims* do serviço, o SDK cliente entra com ele, e a transação grava reserva e evento **sob as
 * Rules** — que aceitam o que é da agência do token e recusam o resto.
 *
 * Roda com `npm run test:emulador` (ver `scripts/emulador.mjs`). Sem o emulador no ambiente, aparece pulado.
 */
import { initializeApp as iniciarAdmin } from 'firebase-admin/app'
import { getAuth as authDoAdmin } from 'firebase-admin/auth'
import { getFirestore as firestoreDoAdmin } from 'firebase-admin/firestore'
import { initializeApp as iniciarCliente } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInWithCustomToken } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'
import { describe, expect, it } from 'vitest'

import { DataCalendario, InstanteLocal, montarReserva, type Reserva } from '@navegsistemas/domain'

import { loteNoFirestore, reservaNoFirestore } from '../src/firestore/reserva-firestore.js'
import { sessaoDoServico, UID_DO_SERVICO } from '../src/firestore/servico.js'

const FIRESTORE = process.env['FIRESTORE_EMULATOR_HOST']
const AUTH = process.env['FIREBASE_AUTH_EMULATOR_HOST']
const EMULADOR = FIRESTORE !== undefined && AUTH !== undefined
const PROJETO = 'demo-fluviapp'
const AGENCIA = 'empresa-naveg'

function reserva(codigo: string, agenciaId = AGENCIA): Reserva {
  const montagem = montarReserva(
    { categoria: 'PASSAGEIRO', acomodacao: 'REDE', tipo: 'INTEIRA', cliente: { nome: 'Maria' } },
    {
      ocorrencia: { viagemId: 'v', data: DataCalendario.de('2026-10-14') as DataCalendario },
      tipoEmbarcacao: 'FERRY_BOAT',
      partida: InstanteLocal.de('2026-10-14T18:00') as InstanteLocal,
    },
    { codigo, criadoEm: InstanteLocal.de('2026-10-13T08:00') as InstanteLocal },
  )
  if (montagem.caso !== 'OK') throw new Error('exemplo incoerente')
  return { ...montagem.reserva, agenciaId }
}

describe.skipIf(!EMULADOR)(`ponta a ponta, no emulador${EMULADOR ? '' : ' — PULADO: sem emulador (npm run test:emulador)'}`, () => {
  it('grava reserva e evento pelo token de serviço, recusa o código em uso, e as Rules recusam outra agência', async () => {
    const admin = iniciarAdmin({ projectId: PROJETO }, 'admin-do-emulador')
    const cliente = iniciarCliente({ apiKey: 'chave-do-emulador', projectId: PROJETO }, 'cliente-do-emulador')
    connectAuthEmulator(getAuth(cliente), `http://${AUTH}`, { disableWarnings: true })
    const db = getFirestore(cliente)
    const [host, porta] = (FIRESTORE as string).split(':')
    connectFirestoreEmulator(db, host as string, Number(porta))

    const obter = sessaoDoServico(AGENCIA, {
      emitirToken: (uid, claims) => authDoAdmin(admin).createCustomToken(uid, { ...claims }),
      entrar: async (token) => {
        await signInWithCustomToken(getAuth(cliente), token)
        return db
      },
    })
    const repositorio = reservaNoFirestore(loteNoFirestore(obter), UID_DO_SERVICO)
    const banco = firestoreDoAdmin(admin)

    expect(await repositorio.criar(reserva('NVG-7K3QP2'))).toEqual({ caso: 'GRAVADA' })
    expect((await banco.doc('reservas/NVG-7K3QP2').get()).data()).toMatchObject({ status: 'RESERVADA', agenciaId: AGENCIA })
    expect((await banco.doc('eventos/reserva.criada:NVG-7K3QP2').get()).data()).toMatchObject({ porId: 'naveg-api' })

    expect(await repositorio.criar(reserva('NVG-7K3QP2'))).toEqual({ caso: 'CODIGO_EM_USO' })

    /* O domínio nunca montaria isto — mas, se montasse, as Rules seguram. É o que a P3 comprou. E é também a
       prova de que o emulador subiu **com** as Rules: sem elas, ele aceita tudo, e este passo falha. */
    expect((await repositorio.criar(reserva('NVG-7K3QP3', 'outra-agencia'))).caso).toBe('FALHA')
    expect((await banco.doc('reservas/NVG-7K3QP3').get()).exists).toBe(false)
  }, 30_000)
})
