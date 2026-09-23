/**
 * **A gravação de ponta a ponta, contra o emulador e as Rules do fluviapp-kmp.**
 *
 * Sobe o emulador do Firestore e o do Auth com o `firestore.rules` do checkout do fluviapp-kmp — a fonte das
 * Rules — e roda `test/emulador.spec.ts` contra eles. Fora daqui aquele cenário aparece **pulado**.
 *
 * O caminho do checkout vem de `FLUVIAPP_KMP` (padrão: `~/AndroidStudioProjects/fluviapp-kmp`). O emulador é
 * Java, e o `firebase-tools` pede JDK 11 ou mais novo no `PATH`.
 *
 * Uso: `npm run test:emulador`
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const KMP = resolve(process.env['FLUVIAPP_KMP'] ?? join(homedir(), 'AndroidStudioProjects', 'fluviapp-kmp'))
const REGRAS = join(KMP, 'firestore.rules')
if (!existsSync(REGRAS)) {
  console.error(`As Rules do fluviapp-kmp não estão em ${REGRAS} — aponte FLUVIAPP_KMP para o checkout.`)
  process.exit(1)
}

/* As Rules vão **copiadas** para junto da configuração, e referidas pelo nome. Com o caminho absoluto (no
   Windows, ao menos) o emulador sobe sem carregá-las — e sem Rules ele aceita tudo, calado. O último passo do
   cenário, que espera a recusa de outra agência, é o que pega isso. */
const pasta = mkdtempSync(join(tmpdir(), 'naveg-emulador-'))
copyFileSync(REGRAS, join(pasta, 'firestore.rules'))
const config = join(pasta, 'firebase.json')
writeFileSync(
  config,
  JSON.stringify({
    firestore: { rules: 'firestore.rules' },
    emulators: { firestore: { port: 8080 }, auth: { port: 9099 }, ui: { enabled: false } },
  }),
)

execFileSync(
  'npx',
  [
    '--yes',
    'firebase-tools@13',
    'emulators:exec',
    '--only',
    'firestore,auth',
    '--project',
    'demo-fluviapp',
    '--config',
    config,
    '"npx vitest run test/emulador.spec.ts"',
  ],
  { stdio: 'inherit', shell: true },
)
