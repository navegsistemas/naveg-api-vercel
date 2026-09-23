# naveg-api-vercel

A API da **agência virtual da NAVEG**. Ela existe para uma coisa só: dar ao totem do
[`naveg-front`](../naveg-front) o que ele precisa do Firestore, e gravar a reserva que ele monta — **sem que
o navegador fale com o banco**.

Não é uma API pública, não é um serviço de plataforma e não é a porta de entrada do fluviapp. É o servidor de
**um** cliente, e o desenho inteiro sai disso.

## Estado

| passo | o que é | estado |
|---|---|---|
| 0 | Esqueleto: Hono na Vercel, configuração que falha na partida, CORS, forma do erro, `GET /saude` | ✅ |
| 1 | `GET /catalogo` — o catálogo do fluviapp, recortado pela concessão da NAVEG | — |
| 2 | `POST /reservas` — a reserva gravada com conta de serviço, com Turnstile e limite por IP | — |

Os passos 1 e 2 são os passos **9 e 10** do
[plano do `naveg-front`](../naveg-front/docs/plano-de-implementacao.md) — o plano é um só, e é lá que ele mora.

## Retomar daqui

**Parei no fim do passo 0.** `npm run verify` deve dar **6 cenários verdes**. O que existe é o esqueleto:
o app do Hono montado com a configuração e as portas (por isso os cenários rodam sem variável de ambiente, sem
rede e sem Firestore), o CORS por lista de origens, a forma única do erro e o `GET /saude`.

**O próximo é o passo 1, `GET /catalogo`** — e ele está bloqueado por coisas que não são código:

1. ~~os repositórios na org~~ **feito.** Os dois estão na `navegsistemas`, e o escopo do pacote passou a ser
   `@navegsistemas` por causa disso — o GitHub Packages exige que o escopo seja o nome da org;
2. **o `@navegsistemas/domain` publicado** (o front faz, pela tag `domain-v0.1.0`), e o `NPM_TOKEN` aqui e na Vercel;
3. **as duas contas de serviço** e o `NAVEG_EMPRESA_ID` — ver "Configuração".

Enquanto isso não vem, o front não fica parado: o totem dele roda contra o catálogo de demonstração.

**Quando destravar**, a ordem é: `npm install @navegsistemas/domain`, o adaptador de leitura do Firestore com porta
falsa nos cenários, a rota, e só então apontar para o Firestore de verdade (o emulador do repositório do
fluviapp serve para isso).

## Onde ela se encaixa

```
┌────────────────────┐      HTTPS (só JSON)      ┌──────────────────────┐
│  naveg-front       │ ────────────────────────▶ │  naveg-api-vercel    │
│  página estática   │  GET  /catalogo           │  (Hono na Vercel)    │
│  + ilha do totem   │  POST /reservas           └──────────┬───────────┘
└────────────────────┘                                      │ conta de serviço
                                                            ▼
                                                    ┌───────────────┐
                                                    │   Firestore   │
                                                    └───────┬───────┘
                                                            │
                          ┌─────────────────────────────────┴──────────┐
                          │  fluviapp — a gestão comercial             │
                          │  (o aplicativo lê `reservas` e emite)      │
                          └────────────────────────────────────────────┘
```

**A NAVEG não é dona do dado.** Rotas, portos, viagens, embarcações e a concessão da agência são cadastrados no
fluviapp; esta API **lê** o que a concessão cobre e **escreve** numa coleção só, `reservas`. Quem transforma
reserva em passagem é o aplicativo, com o funcionário autenticado — nunca esta API.

### O fluviapp-kmp vai virar o sistema centralizador

Hoje a fonte da verdade do domínio é o **aplicativo Android** (`~/Documents/AndroidStudioProjects/fluviapp`), e
é contra ele que o contrato de enums do `naveg-front` confere. O `fluviapp-kmp` está sendo migrado para ser o
centralizador original — quando ele alcançar o aplicativo, duas coisas mudam, e é bom que estejam escritas
antes de acontecerem:

1. **o contrato passa a apontar para o KMP** (`test/contrato-fluviapp.spec.ts`, no `naveg-front`). Hoje ele
   aponta para o aplicativo porque o KMP ainda não tem `ClasseVeiculo`, `NaturezaVeiculo` nem `TipoDocumento`;
2. **esta API pode deixar de existir como está.** Se o centralizador expuser uma API própria de catálogo e de
   reserva, o certo é o front falar com ela, e não com um servidor paralelo lendo o mesmo banco. O que protege
   essa transição é o que já está no lugar: o front depende de **portas** (`FonteDoCatalogo`,
   `ReservaRepositorio`), e trocar de fonte é trocar de adaptador.

Enquanto isso não acontece, esta API é a fronteira — e ela é deliberadamente pequena para ser fácil de
aposentar.

## O que ela é, e o que ela não é

**É** um *backend do front*: as rotas espelham o que a tela precisa, não as tabelas do banco. `GET /catalogo`
devolve o catálogo **já recortado** pela concessão, porque é isso que o totem usa; não há `/viagens`,
`/portos`, nem paginação, nem filtro genérico.

**Não é:**

- **uma API pública.** Só as origens do front podem chamá-la, e o contrato pode mudar junto com a tela;
- **um proxy do Firestore.** O que ela não precisa expor, ela não expõe — `passagens`, `clientes`, `veiculos`,
  `users` e `funcionarios` nunca saem daqui;
- **dona de regra de negócio.** As regras são do `@navegsistemas/domain`, o mesmo pacote que o totem usa;
- **um lugar de autenticação.** A Fase 1 não tem login: a reserva é anônima por decisão, e quem identifica
  quem viaja é o atendimento pessoal. Autenticação é da Fase 2.

## O domínio não mora aqui

A validação da reserva é a **mesma** dos dois lados: `montarReserva`, `paraDocumento`, `travessiasOfertadas` e
os decodificadores do catálogo vêm de `@navegsistemas/domain`, que vive no monorepo do `naveg-front`. No totem, para
responder na hora; aqui, para **decidir**.

Duplicar qualquer parte disso aqui seria refazer o erro que o projeto passou o dia consertando: duas cópias da
mesma regra divergem, e a divergência aparece como dado ilegível em produção, não como teste vermelho.

### De onde ele vem: GitHub Packages

O `@navegsistemas/domain` é publicado pelo monorepo do front no registro do GitHub, e instalado aqui como dependência
normal — com **versão explícita**, que é o que torna o build da Vercel reproduzível. O [`.npmrc`](.npmrc) deste
repositório aponta o escopo `@navegsistemas` para o registro e lê o token do ambiente:

```
@navegsistemas:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

**Para instalar**, com um token de leitura no ambiente:

```bash
export NPM_TOKEN=ghp_…        # PAT clássico com read:packages
npm install @navegsistemas/domain@^0.1.0
```

**Na Vercel**, o mesmo token vai como variável de ambiente `NPM_TOKEN` do projeto (Settings → Environment
Variables). Sem ela, o build falha na instalação — e falha cedo, que é o certo: um build que seguisse sem o
domínio publicaria uma API sem regra nenhuma.

**Para subir uma versão nova do domínio**, é no outro repositório:
`npm version --workspace @navegsistemas/domain patch`, tag `domain-v0.1.1`, push. O workflow de lá publica. Aqui,
`npm update @navegsistemas/domain` quando quiser pegar.

> **O escopo precisa ser o dono do repositório.** O GitHub Packages aceita `@navegsistemas/…` porque o
> `naveg-front` pertence à organização `navegsistemas`. É essa regra que explica o nome do escopo, e não uma
> preferência de estilo.

## As rotas

Todas respondem JSON. O erro tem forma única: `{ erro, mensagem, pendencias? }`, onde `erro` é um **código
estável** que o front traduz para o texto dele. A `mensagem` é para o log, não para a tela.

### `GET /saude`

Diz que o processo subiu e que a configuração está completa. **Não** fala com o Firestore: um health check que
consulta o banco cobra leitura a cada ping e transforma uma instabilidade do Firestore num serviço "fora do
ar", quando o catálogo em cache ainda estaria servindo.

### `GET /catalogo` — passo 1

Devolve o `CatalogoDoFluviapp` já recortado: só as viagens de rota ativa que a concessão da NAVEG cobre, e só
os portos, localidades e embarcações que elas citam. O pool das outras empresas não sai do servidor.

- **A disponibilidade não é calculada aqui.** Quem filtra as saídas por horário é o totem, no navegador, a cada
  minuto, sobre o catálogo em mãos (`travessiasOfertadas`). Por isso o cache de borda de 60 s não faz saída
  vencida aparecer.
- `Cache-Control: public, s-maxage=60, stale-while-revalidate=600`. O catálogo muda quando alguém cadastra uma
  viagem, não a cada pedido.

### `POST /reservas` — passo 2

O corpo é **só o que o cliente pode afirmar**:

```json
{ "viagemId": "…", "data": "2026-10-14", "respostas": { }, "desafio": "token do Turnstile" }
```

O servidor deriva o resto e **não confia em mais nada**:

1. valida o desafio e o limite por IP;
2. carrega o catálogo e procura a travessia `viagemId@data` entre as **ofertadas agora**. Não achou — inativa,
   fora da concessão, ou já partiu — é `409 TRAVESSIA_INDISPONIVEL`;
3. monta com `montarReserva`, usando **código e instante do servidor**. Se o corpo trouxer `codigo` ou
   `criadoEm`, são ignorados;
4. incoerente é `422 RESERVA_INCOERENTE` com as pendências tipadas — o front já tem texto para cada uma;
5. grava com `create`. Documento existente gera outro código e monta de novo, até cinco vezes.

Responde `201 { "codigo": "NVG-7K3QP2" }`.

## Segurança

**Duas contas de serviço, e não uma.** O IAM do Firestore não distingue coleção: uma conta com papel de escrita
pode escrever em qualquer lugar do banco — inclusive em `passagens`. Por isso a rota do catálogo usa uma conta
com **`Cloud Datastore Viewer`** e a de reservas, uma com `Cloud Datastore User`. Não é defesa contra invasor
com acesso ao ambiente; é defesa contra **nós mesmos** — um `set` escrito no lugar errado falha em vez de
gravar.

O resto:

- **O Admin SDK passa por cima das Firestore Rules.** Isso é o que faz `reservas` poder ficar fechada ao
  público, e é também o que torna o código desta API a última linha de defesa. Toda escrita passa pelo domínio.
- **Turnstile** no `POST`: sem App Check (que só existe para clientes Firebase), é o que responde *"tem gente
  do outro lado?"*.
- **Limite por IP** em Upstash Redis. Em memória não serve: a Vercel invoca funções, e cada instância teria o
  próprio contador.
- **CORS** com lista explícita de origens. Nunca `*`.
- **Segredos só de runtime**, nas variáveis de ambiente da Vercel. Nenhum prefixo público, nada no repositório.
- **Log sem dado pessoal.** Nome e telefone de quem reserva **não** vão para o log — nem em erro. O que
  identifica um pedido no log é o código da reserva.

## Configuração

Copie `.env.example` para `.env`. Todas são obrigatórias, e a ausência de qualquer uma derruba a partida com a
lista inteira do que falta — não uma por vez.

| variável | o que é |
|---|---|
| `FIREBASE_PROJECT_ID` | o projeto Firebase do fluviapp |
| `FIREBASE_CONTA_DE_LEITURA` | JSON da conta de serviço com `Cloud Datastore Viewer` |
| `FIREBASE_CONTA_DE_ESCRITA` | JSON da conta de serviço com `Cloud Datastore User` |
| `NAVEG_EMPRESA_ID` | a empresa NAVEG no fluviapp, para achar `empresas/{id}/atuacoes/AGENCIAMENTO` |
| `ORIGENS_PERMITIDAS` | as origens do front, separadas por vírgula |
| `TURNSTILE_SECRET` | a chave secreta do desafio (passo 2) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | o limite por IP (passo 2) |

## Rodando

```bash
export NPM_TOKEN=ghp_…   # para o @navegsistemas/domain; ver acima
npm install
npm run dev        # vercel dev, com o .env local
npm run verify     # typecheck + cenários
npm test
```

Contra o **emulador** do Firestore (sem tocar em produção), aponte `FIRESTORE_EMULATOR_HOST` para ele: o Admin
SDK respeita a variável e ignora as credenciais. O emulador é o do repositório do fluviapp, que já tem a suíte
de Rules.

E **sem credencial nenhuma** o front continua rodável: o totem cai no catálogo de demonstração dele, com a
faixa dizendo que as saídas são fictícias. Ninguém precisa desta API para mexer na tela.

## Cenários

`vitest`, e a régua é a do `naveg-front`: o app é **montado com a configuração e as portas**, então nenhum
cenário precisa de variável de ambiente, de rede ou de Firestore. Os adaptadores de verdade têm cenário próprio
contra o emulador.

O que se confere aqui não é o domínio — ele tem os cenários dele, no pacote dele. É **a fronteira**: o que o
servidor aceita do cliente, o que ele deriva sozinho, o que ele recusa, e o que ele nunca devolve.

## Deploy

Vercel, funções **Node** (não edge: o `firebase-admin` depende de APIs de Node). O `vercel.json` manda todo
caminho para `api/index.ts`, que é o adaptador do Hono — o mesmo app que os cenários montam.

O que a plataforma impõe, e que o desenho já leva em conta:

- **sem processo de pé**: nada de estado entre requisições (daí o Redis para o limite);
- **cold start**: o Admin SDK é inicializado no escopo do módulo, para as invocações seguintes reaproveitarem;
- **timeout de dezenas de segundos** e **sem WebSocket**: nenhuma rota precisa de mais do que uma leitura e uma
  escrita curtas.

## Decisões que vieram do `naveg-front`

Estes ADRs são de lá, e valem aqui:

- [ADR-0001 — A reserva é um tipo próprio](../naveg-front/docs/adr/ADR-0001-a-reserva-como-tipo-proprio.md);
- [ADR-0002 — A escrita client-side, e o que de fato a protege](../naveg-front/docs/adr/ADR-0002-a-escrita-client-side-e-o-que-a-protege.md)
  — em especial a **segunda emenda**, que é a que criou este projeto.

Decisão daqui, quando houver, vira ADR **aqui** — e a primeira candidata é a de como consumir o
`@navegsistemas/domain`.
