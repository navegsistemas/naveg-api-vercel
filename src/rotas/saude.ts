/**
 * **`GET /saude`** — a rota que diz que o processo subiu e a configuração está completa.
 *
 * Ela **não** fala com o Firestore. Um health check que consulta o banco vira duas coisas ruins: conta como
 * leitura cobrada a cada ping de monitoramento, e transforma uma indisponibilidade do Firestore num serviço
 * "fora do ar" — quando o catálogo em cache ainda estaria servindo.
 *
 * O que ela responde é o que dá para afirmar sem sair do processo: que o app respondeu.
 */
import { Hono } from 'hono'

export function rotaDeSaude(): Hono {
  const rota = new Hono()

  rota.get('/', (c) => c.json({ estado: 'ok' }))

  return rota
}
