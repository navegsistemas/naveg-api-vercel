/**
 * **Os e-mails da conta, escritos** — o texto e o HTML de cada um. Quem manda é o carteiro (`email/smtp.ts`).
 *
 * - **a confirmação** (3.2): o texto do wireframe da 3.2, aceito pelo PO em 2026-10-16. Curto, com um botão só, e o
 *   endereço do link também em texto, para quem não consegue tocar no botão;
 * - **o cadastro repetido**: a frase das regras da conta (PO, 2026-10-21: "Não revelar"). O cadastro responde igual
 *   ao e-mail novo e ao já usado; a diferença vai por aqui, para o dono do e-mail, e só ele lê.
 *
 * Saem de `naoresponda@gruponaveg.com.br`, e as respostas vão ao `contato@` (B da área do cliente). O nome da pessoa
 * vai escapado no HTML: é texto que ela digitou.
 */
import type { MensagemDeEmail } from '../portas.js'

type Email = MensagemDeEmail

export const ATENDIMENTO_POR_EMAIL = 'contato@gruponaveg.com.br'
export const ATENDIMENTO_POR_WHATSAPP = '(91) 99203-5322'

const RODAPE_EM_TEXTO = `Este endereço não recebe respostas. Para falar com a gente: ${ATENDIMENTO_POR_EMAIL} ou o WhatsApp ${ATENDIMENTO_POR_WHATSAPP}.`

function escapar(texto: string): string {
  return texto
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** O primeiro nome, para o "Olá": "Maria Souza" → "Maria". */
export function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? ''
}

/** A moldura de todo e-mail: a faixa com o nome NAVEG, o miolo e o rodapé. Sem imagem, para não depender de nada. */
function html(miolo: string, rodape: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:24px 12px;background:#f7f4f1;font-family:Arial,Helvetica,sans-serif;color:#1b1006">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #d8cfc7;border-radius:10px;padding:24px">
<p style="margin:0 0 18px;padding-bottom:8px;border-bottom:3px solid #fa8b17;font-family:Georgia,serif;font-weight:bold;font-size:20px;letter-spacing:2px;color:#103a5b">NAVEG</p>
${miolo}
<p style="margin:22px 0 0;padding-top:12px;border-top:1px solid #d8cfc7;font-size:12px;line-height:1.5;color:#6b5443">${rodape}</p>
</div>
</body>
</html>`
}

const PARAGRAFO = 'margin:0 0 14px;font-size:15px;line-height:1.5'

/** **Confirme seu e-mail** (3.2): o link de 24 horas. */
export function emailDeConfirmacao(para: string, nome: string, link: string): Email {
  const ola = `Olá, ${primeiroNome(nome)}!`
  const aviso = 'Se você não criou uma conta na NAVEG, ignore este e-mail: sem a confirmação, nada acontece.'
  return {
    para,
    assunto: 'Confirme seu e-mail na NAVEG',
    texto: [
      ola,
      '',
      'Falta só confirmar seu e-mail para terminar sua conta no site da NAVEG.',
      '',
      `Confirmar e-mail: ${link}`,
      '',
      'O link vale por 24 horas.',
      '',
      aviso,
      RODAPE_EM_TEXTO,
    ].join('\n'),
    html: html(
      `<p style="${PARAGRAFO}">${escapar(ola)}</p>
<p style="${PARAGRAFO}">Falta só confirmar seu e-mail para terminar sua conta no site da NAVEG.</p>
<p style="margin:0 0 18px"><a href="${escapar(link)}" style="display:inline-block;padding:13px 22px;border-radius:4px;background:#fa8b17;color:#1b1006;font-weight:bold;text-decoration:none">Confirmar e-mail</a></p>
<p style="margin:0 0 6px;font-size:13px;color:#6b5443">O link vale por 24 horas. Se o botão não abrir, copie este endereço no navegador:</p>
<p style="margin:0;font-family:Consolas,monospace;font-size:12px;color:#103a5b;word-break:break-all">${escapar(link)}</p>`,
      `${escapar(aviso)}<br>${escapar(RODAPE_EM_TEXTO)}`,
    ),
  }
}

/** **O cadastro com um e-mail que já tem conta**: o aviso ao dono, sem link (PO, 2026-10-21). */
export function emailDeCadastroRepetido(para: string, site: string): Email {
  const frase = "Alguém tentou criar uma conta com este e-mail. Se foi você, entre ou use 'Esqueci a senha'."
  const entrar = `${site.replace(/\/$/, '')}/conta`
  const aviso = 'Se não foi você, não precisa fazer nada: sua conta continua como estava.'
  return {
    para,
    assunto: 'Tentativa de criar uma conta na NAVEG',
    texto: [frase, '', `Entrar: ${entrar}`, '', aviso, RODAPE_EM_TEXTO].join('\n'),
    html: html(
      `<p style="${PARAGRAFO}">${escapar(frase)}</p>
<p style="margin:0 0 18px"><a href="${escapar(entrar)}" style="display:inline-block;padding:13px 22px;border-radius:4px;background:#fa8b17;color:#1b1006;font-weight:bold;text-decoration:none">Entrar</a></p>
<p style="${PARAGRAFO}">${escapar(aviso)}</p>`,
      escapar(RODAPE_EM_TEXTO),
    ),
  }
}

/** **Esqueci a senha** (3.4): o link de 1 hora, que vale uma vez só. */
export function emailDeTrocaDeSenha(para: string, nome: string, link: string): Email {
  const ola = `Olá, ${primeiroNome(nome)}!`
  const aviso = 'Se você não pediu para trocar a senha, ignore este e-mail: sua senha continua a mesma.'
  return {
    para,
    assunto: 'Troque sua senha na NAVEG',
    texto: [
      ola,
      '',
      'Recebemos um pedido para trocar a senha da sua conta no site da NAVEG.',
      '',
      `Trocar a senha: ${link}`,
      '',
      'O link vale por 1 hora, e uma vez só.',
      '',
      aviso,
      RODAPE_EM_TEXTO,
    ].join('\n'),
    html: html(
      `<p style="${PARAGRAFO}">${escapar(ola)}</p>
<p style="${PARAGRAFO}">Recebemos um pedido para trocar a senha da sua conta no site da NAVEG.</p>
<p style="margin:0 0 18px"><a href="${escapar(link)}" style="display:inline-block;padding:13px 22px;border-radius:4px;background:#fa8b17;color:#1b1006;font-weight:bold;text-decoration:none">Trocar a senha</a></p>
<p style="margin:0 0 6px;font-size:13px;color:#6b5443">O link vale por 1 hora, e uma vez só. Se o botão não abrir, copie este endereço no navegador:</p>
<p style="margin:0;font-family:Consolas,monospace;font-size:12px;color:#103a5b;word-break:break-all">${escapar(link)}</p>`,
      `${escapar(aviso)}<br>${escapar(RODAPE_EM_TEXTO)}`,
    ),
  }
}

/** **A conta desativada pediu a troca** (3.4, F): o aviso, com o WhatsApp, e nenhum link. */
export function emailDeContaDesativada(para: string): Email {
  const frase = 'Recebemos um pedido para trocar a senha da sua conta no site da NAVEG, mas esta conta está desativada.'
  const saida = `Para reativar, fale com o atendimento pelo WhatsApp ${ATENDIMENTO_POR_WHATSAPP}.`
  const aviso = 'Se você não pediu, ignore este e-mail.'
  return {
    para,
    assunto: 'Sua conta na NAVEG está desativada',
    texto: [frase, '', saida, '', aviso, RODAPE_EM_TEXTO].join('\n'),
    html: html(
      `<p style="${PARAGRAFO}">${escapar(frase)}</p>
<p style="${PARAGRAFO}">${escapar(saida)}</p>
<p style="${PARAGRAFO}">${escapar(aviso)}</p>`,
      escapar(RODAPE_EM_TEXTO),
    ),
  }
}

/**
 * O e-mail com o meio escondido, para o aviso ao endereço antigo: "joao.lima@exemplo.com.br" → "j•••a@exemplo.com.br".
 * Quem lê reconhece o próprio pedido, e quem não pediu não fica sabendo o endereço inteiro de quem pediu.
 */
export function emailMascarado(email: string): string {
  const arroba = email.lastIndexOf('@')
  const nome = email.slice(0, arroba)
  const visivel = nome.length <= 2 ? `${nome.slice(0, 1)}•••` : `${nome.slice(0, 1)}•••${nome.slice(-1)}`
  return `${visivel}${email.slice(arroba)}`
}

/** **Confirme o e-mail novo** (4.2, B): o link de 24 horas, ao endereço que vai valer. */
export function emailDeTrocaDeEmail(para: string, nome: string, link: string): Email {
  const ola = `Olá, ${primeiroNome(nome)}!`
  const frase = 'Recebemos um pedido para usar este e-mail na sua conta do site da NAVEG.'
  const aviso = 'Se você não pediu, ignore este e-mail: sem a confirmação, nada muda.'
  return {
    para,
    assunto: 'Confirme seu e-mail novo na NAVEG',
    texto: [
      ola,
      '',
      frase,
      '',
      `Confirmar o e-mail novo: ${link}`,
      '',
      'O link vale por 24 horas. O e-mail antigo continua valendo até a confirmação.',
      '',
      aviso,
      RODAPE_EM_TEXTO,
    ].join('\n'),
    html: html(
      `<p style="${PARAGRAFO}">${escapar(ola)}</p>
<p style="${PARAGRAFO}">${escapar(frase)}</p>
<p style="margin:0 0 18px"><a href="${escapar(link)}" style="display:inline-block;padding:13px 22px;border-radius:4px;background:#fa8b17;color:#1b1006;font-weight:bold;text-decoration:none">Confirmar o e-mail novo</a></p>
<p style="margin:0 0 6px;font-size:13px;color:#6b5443">O link vale por 24 horas. O e-mail antigo continua valendo até a confirmação. Se o botão não abrir, copie este endereço no navegador:</p>
<p style="margin:0;font-family:Consolas,monospace;font-size:12px;color:#103a5b;word-break:break-all">${escapar(link)}</p>`,
      `${escapar(aviso)}<br>${escapar(RODAPE_EM_TEXTO)}`,
    ),
  }
}

/**
 * **O aviso ao e-mail antigo** (4.2, B; PO, 2026-10-23): sai no pedido, e não só na troca feita, para a dona da conta
 * saber enquanto o link ainda não foi aberto.
 */
export function emailDeTrocaDeEmailPedida(para: string, nome: string, novoEmail: string): Email {
  const ola = `Olá, ${primeiroNome(nome)}!`
  const frase = `Foi pedido, na sua conta do site da NAVEG, trocar o e-mail para ${emailMascarado(novoEmail)}. A troca só vale depois que o e-mail novo for confirmado.`
  const saida = `Se não foi você, troque sua senha e fale com o atendimento pelo WhatsApp ${ATENDIMENTO_POR_WHATSAPP}.`
  return {
    para,
    assunto: 'Pedido de troca do e-mail da sua conta',
    texto: [ola, '', frase, '', saida, '', RODAPE_EM_TEXTO].join('\n'),
    html: html(
      `<p style="${PARAGRAFO}">${escapar(ola)}</p>
<p style="${PARAGRAFO}">${escapar(frase)}</p>
<p style="${PARAGRAFO}"><b>${escapar(saida)}</b></p>`,
      escapar(RODAPE_EM_TEXTO),
    ),
  }
}

/**
 * **O e-mail novo já é de outra conta** (4.2, B; PO, 2026-10-23): o aviso do cadastro repetido, ao dono desse
 * endereço, sem link. A tela respondeu como sempre; só ele fica sabendo.
 */
export function emailDeEmailJaUsado(para: string, site: string): Email {
  const frase = "Alguém tentou usar este e-mail numa conta da NAVEG. Se foi você, entre ou use 'Esqueci a senha'."
  const entrar = `${site.replace(/\/$/, '')}/conta`
  const aviso = 'Se não foi você, não precisa fazer nada: sua conta continua como estava.'
  return {
    para,
    assunto: 'Tentativa de usar seu e-mail na NAVEG',
    texto: [frase, '', `Entrar: ${entrar}`, '', aviso, RODAPE_EM_TEXTO].join('\n'),
    html: html(
      `<p style="${PARAGRAFO}">${escapar(frase)}</p>
<p style="margin:0 0 18px"><a href="${escapar(entrar)}" style="display:inline-block;padding:13px 22px;border-radius:4px;background:#fa8b17;color:#1b1006;font-weight:bold;text-decoration:none">Entrar</a></p>
<p style="${PARAGRAFO}">${escapar(aviso)}</p>`,
      escapar(RODAPE_EM_TEXTO),
    ),
  }
}

/** **Sua senha foi trocada** (3.4, D): a hora, e o WhatsApp para quem não reconhece a troca. */
export function emailDeSenhaTrocada(para: string, nome: string, quando: string): Email {
  const ola = `Olá, ${primeiroNome(nome)}!`
  const frase = `A senha da sua conta no site da NAVEG foi trocada em ${quando}. A conta saiu dos outros aparelhos.`
  const saida = `Se não foi você, fale agora com o atendimento pelo WhatsApp ${ATENDIMENTO_POR_WHATSAPP}.`
  return {
    para,
    assunto: 'Sua senha foi trocada',
    texto: [ola, '', frase, '', saida, '', RODAPE_EM_TEXTO].join('\n'),
    html: html(
      `<p style="${PARAGRAFO}">${escapar(ola)}</p>
<p style="${PARAGRAFO}">${escapar(frase)}</p>
<p style="${PARAGRAFO}"><b>${escapar(saida)}</b></p>`,
      escapar(RODAPE_EM_TEXTO),
    ),
  }
}
