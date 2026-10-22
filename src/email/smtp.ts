/**
 * **O carteiro no Google Workspace** — o adaptador de `CarteiroDeEmail`, pelo SMTP do Gmail com uma senha de app.
 *
 * - **de `naoresponda@gruponaveg.com.br`**, um apelido da conta Workspace que entra no SMTP (B da área do cliente). O
 *   Gmail só manda pelo apelido se ele estiver em "Enviar e-mail como" dessa conta; sem isso, ele troca o remetente
 *   pelo endereço da conta, em silêncio;
 * - **as respostas vão ao `contato@`** (`Reply-To`);
 * - **a senha de app é da conta do PO** (2026-10-22): ela abre a caixa inteira, e trocar a senha principal da conta
 *   derruba o envio. O risco está aceito e anotado no README do `naveg-front`; a saída é uma conta só para enviar;
 * - **o log não leva o endereço de ninguém**: só o assunto e o código do erro.
 *
 * O Workspace tem limite de envios por dia (2.000 por conta). O "Reenviar" tem o freio dele (3.2, B), no PR que o traz.
 */
import { createTransport } from 'nodemailer'

import type { ContaDeEnvio } from '../config.js'
import type { CarteiroDeEmail } from '../portas.js'

/** O nome que aparece na caixa de entrada, antes do endereço. */
export const NOME_DO_REMETENTE = 'NAVEG'

export function carteiroNoWorkspace(conta: ContaDeEnvio): CarteiroDeEmail {
  const transporte = createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: conta.usuario, pass: conta.senhaDeApp },
    /* Uma função da Vercel não espera para sempre: sem resposta em 10 s, o envio falha e o log diz. */
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  })

  return {
    async enviar(mensagem) {
      try {
        await transporte.sendMail({
          from: { name: NOME_DO_REMETENTE, address: conta.remetente },
          replyTo: conta.responderPara,
          to: mensagem.para,
          subject: mensagem.assunto,
          text: mensagem.texto,
          html: mensagem.html,
        })
        return true
      } catch (erro) {
        const codigo = (erro as { code?: unknown; responseCode?: unknown } | null) ?? {}
        console.error(
          `e-mail "${mensagem.assunto}" não saiu: ${String(codigo.code)} (SMTP ${String(codigo.responseCode)})`,
        )
        return false
      }
    },
  }
}
