/**
 * **A origem de quem muda alguma coisa** — só o site da agência.
 *
 * Não é segurança sozinha: quem não é navegador manda a origem que quiser. Mas tira o tráfego trivial de cima do
 * resto, e é ela que impede outro site de fazer o navegador de alguém mandar um `POST` em nome do site da agência
 * (com a sessão, a partir do PR de entrar, isso deixa de ser só volume). Todo `POST` confere, **antes de ler um
 * byte do corpo**.
 */
import { ErroDaApi } from '../erros.js'

export function conferirOrigem(origem: string | undefined, permitidas: readonly string[]): void {
  if (origem === undefined || !permitidas.includes(origem)) {
    throw new ErroDaApi(403, 'ORIGEM_NAO_PERMITIDA', 'Origem não permitida')
  }
}
