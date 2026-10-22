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

import {
  contaNova,
  DataCalendario,
  InstanteLocal,
  loteDaContaNova,
  montarEncomenda,
  montarReserva,
  type Reserva,
  type RespostasDaEncomenda,
} from '@navegsistemas/domain'

import { contasNoFirestore } from '../src/firestore/conta-firestore.js'
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
      /* Com o celular: pelo site ele é obrigatório desde a 2.3 (domain 0.12.0). */
      {
        canal: 'SITE',
        categoria: 'PASSAGEIRO',
        quantidadePessoas: 7,
        acomodacao: 'SUITE',
        cliente: { nome: 'Maria', telefone: '(91) 98888-7777' },
      },
      saida(),
      { codigo: 'NVG-5ATE07', criadoEm: InstanteLocal.de(`${VESPERA}T08:00`) as InstanteLocal, agenciaId: AGENCIA },
    )
    if (doSite.caso !== 'OK') throw new Error('exemplo incoerente')
    expect(await repositorio.criar(doSite.reserva)).toEqual({ caso: 'GRAVADA' })
    const gravada = (await banco.doc('reservas/NVG-5ATE07').get()).data()
    expect(gravada).toMatchObject({ acomodacao: 'SUITE', quantidadePessoas: 7 })
    expect(gravada).not.toHaveProperty('tipo')

    /* Passageiros e veículo (naveg-front#66): a reserva de veículo leva as pessoas. As Rules do KMP aceitam as chaves de
       pessoas na categoria VEICULO sem mudar (PO, 2026-10-14). */
    const juntos = montarReserva(
      {
        canal: 'SITE',
        embarque: 'PASSAGEIROS_E_VEICULO',
        porteVeiculo: 'PESADO',
        classeVeiculo: 'CAMINHAO',
        quantidadePessoas: 3,
        acomodacao: 'REDE',
        cliente: { nome: 'Maria', telefone: '(91) 98888-7777' },
      },
      saida(),
      { codigo: 'NVG-CAM1N3', criadoEm: InstanteLocal.de(`${VESPERA}T08:00`) as InstanteLocal, agenciaId: AGENCIA },
    )
    if (juntos.caso !== 'OK') throw new Error('exemplo incoerente')
    expect(await repositorio.criar(juntos.reserva)).toEqual({ caso: 'GRAVADA' })
    expect((await banco.doc('reservas/NVG-CAM1N3').get()).data()).toMatchObject({
      categoria: 'VEICULO',
      classe: 'CAMINHAO',
      quantidadePessoas: 3,
      acomodacao: 'REDE',
    })

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

    /* A da 2.7 (naveg-front#72): sem quem retira, o atendimento combina. As Rules do KMP aceitam (fluviapp-kmp#43). */
    const aCombinar = encomenda('NVG-ENC0M4', {
      tipoVolume: 'CAIXA',
      quantidadeVolumes: 2,
      faixaPeso: 'DE_5_A_20',
      cliente: { nome: 'Maria', telefone: '(91) 98888-7777' },
    })
    expect(await repositorio.criar(aCombinar)).toEqual({ caso: 'GRAVADA' })
    expect((await banco.doc('reservas/NVG-ENC0M4').get()).data()).not.toHaveProperty('retirada')

    /* E o que o domínio não monta, as Rules também recusam: quem manda e retira, sem celular. */
    expect((await repositorio.criar({ ...doProprio, codigo: 'NVG-ENC0M3', cliente: { nome: 'Carlos' } })).caso).toBe('FALHA')
    expect((await banco.doc('reservas/NVG-ENC0M3').get()).exists).toBe(false)
  }, 30_000)

  it('o cadastro (naveg-api-vercel#30, PR 5): a conta, os segredos e o resumo num lote, e a procura pelo e-mail', async () => {
    const admin = iniciarAdmin({ projectId: PROJETO }, 'admin-da-conta')
    const cliente = iniciarCliente({ apiKey: 'chave-do-emulador', projectId: PROJETO }, 'cliente-da-conta')
    connectAuthEmulator(getAuth(cliente), `http://${AUTH}`, { disableWarnings: true })
    const db = getFirestore(cliente)
    const [host, porta] = (FIRESTORE as string).split(':')
    connectFirestoreEmulator(db, host as string, Number(porta))
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const chave = { clientEmail: `naveg-api-escrita@${PROJETO}.iam.gserviceaccount.com`, privateKey }
    const obter = sessaoDoServico(AGENCIA, {
      emitirToken: async (uid, claims) => assinarTokenCustomizado(chave, uid, { ...claims }),
      entrar: async (token) => {
        await signInWithCustomToken(getAuth(cliente), token)
        return db
      },
    })
    const banco = firestoreDoAdmin(admin)
    const contas = contasNoFirestore(obter, AGENCIA)
    const hoje = DataCalendario.de('2026-10-21') as DataCalendario
    const nova = (id: string, email: string) => {
      const cadastro = { nome: 'Maria Souza', dataNascimento: '1990-05-20', email, telefone: '(91) 98888-7777', senha: 'rio e maré' }
      const resultado = contaNova(id, cadastro, 1_792_600_000_000, hoje)
      if (resultado.caso !== 'CONTA') throw new Error('exemplo incoerente')
      return loteDaContaNova(resultado.conta)
    }
    const acesso = { resumoDaSenha: 'scrypt$15$8$3$c2Fs$cmVzdW1v', geracao: 0, errosSeguidos: 0 }
    const confirmacao = { resumoDoCodigo: 'a'.repeat(64), valeAte: 1_792_686_400_000 }

    expect(await contas.existeComEmail('maria@exemplo.com.br')).toBe(false)
    expect(
      await contas.criar('conta-1', nova('conta-1', 'maria@exemplo.com.br'), acesso, confirmacao, 1_792_600_000_000),
    ).toBe(true)
    expect(await contas.existeComEmail('maria@exemplo.com.br')).toBe(true)

    const base = `empresas/${AGENCIA}`
    expect((await banco.doc(`${base}/contasDeCliente/conta-1`).get()).data()).toMatchObject({
      email: 'maria@exemplo.com.br',
      telefone: '5591988887777',
      ativa: true,
    })
    expect((await banco.doc(`${base}/contasDeCliente/conta-1/segredos/acesso`).get()).data()).toEqual(acesso)
    expect((await banco.doc(`${base}/contasDeCliente/conta-1/segredos/confirmacao`).get()).data()).toEqual(confirmacao)
    expect((await banco.doc(`${base}/resumos/contasDeCliente`).get()).data()).toEqual({
      total: 1,
      confirmadas: 0,
      ultimaCriadaEm: 1_792_600_000_000,
    })

    /* A segunda soma no resumo, sem apagar a primeira. */
    expect(
      await contas.criar('conta-2', nova('conta-2', 'joao@exemplo.com.br'), acesso, confirmacao, 1_792_600_100_000),
    ).toBe(true)
    expect((await banco.doc(`${base}/resumos/contasDeCliente`).get()).data()).toMatchObject({ total: 2, confirmadas: 0 })

    /* O serviço da NAVEG não grava no cadastro de outra agência: as Rules recusam o lote inteiro. */
    const deOutra = contasNoFirestore(obter, 'outra-agencia')
    expect(
      await deOutra.criar('conta-3', nova('conta-3', 'ana@exemplo.com.br'), acesso, confirmacao, 1_792_600_200_000),
    ).toBe(false)
    expect((await banco.doc('empresas/outra-agencia/contasDeCliente/conta-3').get()).exists).toBe(false)

    /* O PR 6: o envio espelhado para o painel, a leitura do link, e a confirmação num lote — sob as Rules. */
    await contas.registrarEnvio('conta-1', 'CONFIRMACAO', 1_792_600_000_500)
    expect((await banco.doc(`${base}/contasDeCliente/conta-1`).get()).data()).toMatchObject({
      ultimoEnvioTipo: 'CONFIRMACAO',
      ultimoEnvioEm: 1_792_600_000_500,
    })
    expect(await contas.paraConfirmar('conta-1')).toEqual({ confirmadaEm: null, confirmacao })
    expect(await contas.paraConfirmar('nao-existe')).toBeNull()

    expect(await contas.confirmar('conta-1', 1_792_600_300_000)).toBe(true)
    expect((await banco.doc(`${base}/contasDeCliente/conta-1`).get()).data()).toMatchObject({
      confirmadaEm: 1_792_600_300_000,
    })
    expect((await banco.doc(`${base}/contasDeCliente/conta-1/segredos/confirmacao`).get()).exists).toBe(false)
    expect((await banco.doc(`${base}/resumos/contasDeCliente`).get()).data()).toMatchObject({ total: 2, confirmadas: 1 })
    expect(await contas.paraConfirmar('conta-1')).toEqual({ confirmadaEm: 1_792_600_300_000, confirmacao: null })
  }, 30_000)
})
