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
| 1 | `GET /catalogo` — o catálogo do fluviapp, recortado pela concessão da NAVEG | ✅ |
| 2 | `POST /reservas` — a reserva gravada com conta de serviço, com Turnstile e limite por IP | ✅ código · ⏳ ligar |

Os passos 1 e 2 são os passos **9 e 10** do
[plano do `naveg-front`](../naveg-front/docs/plano-de-implementacao.md) — o plano é um só, e é lá que ele mora.

## Retomar daqui

**Desde 2026-09-23 a API grava sob as Rules do fluviapp** (a P3 do ADR-0010 do `fluviapp-kmp`, desenhada no
ADR-0013 de lá). A conta de escrita não grava mais: ela **assina um token customizado** para o usuário de serviço
`naveg-api` (*claims* `papel: SERVICO` e a agência), e a gravação vai pelo SDK cliente, numa transação que
confere o código livre e grava a reserva **e o evento `reserva.criada`** juntos (`src/firestore/servico.ts` e
`reserva-firestore.ts`). `npm run verify` dá **56 cenários verdes** e um pulado — o de ponta a ponta, que roda
com `npm run test:emulador`.

**Para ligar esta versão**, nesta ordem:

1. o `fluviapp-kmp` com as Rules novas publicadas no projeto (o merge do PR de lá faz isso em homologação);
2. o `@navegsistemas/domain` **0.5.0** publicado — feito em 2026-09-23, e o `package-lock.json` já o registra;
3. na Vercel, `FIREBASE_WEB_API_KEY` = a `apiKey` do app Web do Firebase; redeploy;
4. **depois de ver uma reserva gravada**, tirar o papel *Cloud Datastore User* da `naveg-api-escrita` no IAM.
   Enquanto ele existir, uma chave vazada ainda grava por cima das Rules — é o passo que fecha a P3.

**O passo 2, como ficou antes disso.** O `POST /reservas`
existe inteiro — a rota (`src/rotas/reservas.ts`), a reserva no Firestore com a conta de escrita
(`src/firestore/reserva-firestore.ts`), o desafio na Cloudflare e o limite no Upstash (`src/protecao/`) — e
passou pela revisão de segurança que o plano exige antes do deploy. **Ele está no ar desligado**: sem as três
variáveis da proteção, responde `503 ENVIO_INDISPONIVEL`, e o catálogo segue servindo.

**Para ligar** (em dev, sem conta na Cloudflare):

1. criar um banco no [Upstash](https://upstash.com) (plano gratuito, Redis) e copiar a URL e o token REST;
2. na Vercel, `TURNSTILE_SECRET=1x0000000000000000000000000000000AA` (a chave **de teste** da Cloudflare, que
   sempre passa), `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`; redeploy;
3. no front, `PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA` (a pública de teste) num `apps/agencia/.env`.

Antes de abrir ao público, as chaves de teste dão lugar às de um widget de verdade, criado no painel da
Cloudflare e restrito ao domínio da agência.

**Decisões tomadas no passo 2, para confirmar** (todas com cenário, fáceis de mudar):

- **limite de 10 envios por IP a cada 10 minutos**; se o Upstash cair, **deixa passar** (e registra) — o
  Turnstile continua de pé, e recusar todo mundo seria pior;
- **nome até 100 caracteres**, telefone até 30; a **observação é ignorada** (o totem não tem o campo);
- a reserva é gravada com `agenciaId` = `NAVEG_EMPRESA_ID`;
- o IP vai **inteiro** para a Cloudflare (ela precisa dele para conferir o desafio) e **resumido** (hash) para
  o Upstash. A Cloudflare passa a tratar dado pessoal em nome da NAVEG — a política de privacidade tem de dizer
  isso.

**O aceite do plano está completo:** a escrita ponta a ponta contra o **emulador** do Firestore e do Auth, com as
Rules do fluviapp-kmp carregadas, é o `test/emulador.spec.ts` (`npm run test:emulador`; lê as Rules do
checkout em `FLUVIAPP_KMP`). Ele prova também o que as Rules recusam: a reserva de outra agência não grava.

**No ar desde 2026-09-23**, em `https://naveg-api-vercel.vercel.app`: `/saude` e `/catalogo` respondem `200`,
com CORS para `http://localhost:4321`, lendo o `fluvi-app-dev` com a conta de leitura. **Visto de ponta a ponta** no mesmo dia: o
`/catalogo` devolve as duas viagens do F/B REGIONAL (Porto Brilhante · Belém/PA → Porto do Grego · Santana/AP),
recortadas pela concessão, e o `catalogoHttp` do front as transforma nas saídas que o totem oferta. Cada
leitura deixa no log da Vercel uma linha só com contagens ("pool: N viagens…; concessão: N embarcações e N
portos; ofertável depois do recorte: N viagens") — se um dia o catálogo vier vazio, ela diz se falta viagem no
pool, id na concessão, ou viagem que a concessão cubra.

Duas lições da subida, para a próxima vez:

- **variável nova só vale com deploy novo.** Salvar na Vercel não reinicia a função que está no ar;
- **a chave JSON só se baixa uma vez**, na criação. O que a aba "Chaves" do console mostra é o *id* da chave, e
  colá-lo na variável dá "o valor não é JSON".

**As origens do front, por ambiente** (2026-09-24). O front está na Vercel (`naveg-front-agencia`), e cada
escopo da `ORIGENS_PERMITIDAS` libera só o front do mesmo ambiente:

| escopo | origens | de onde vem |
|---|---|---|
| *Preview* | `http://localhost:4321`, `https://naveg-front-agencia.vercel.app` | a homologação do front (a `main` de lá) |
| *Production* | `http://localhost:4321`, `https://naveg-front-agencia.vercel.app` | **provisório:** até existir o domínio de homologação da API, o deploy de produção daqui (sobre o `fluvi-app-dev`) faz as vezes de homologação. O domínio oficial entra no lançamento |

O desenho é o front de homologação falar com a **homologação** da API (um domínio próprio fixo na `main`
daqui — o login da Vercel não deixa um `*.vercel.app` de preview ser chamado pelo navegador). **Enquanto esse
domínio não existe**, ele fala com o `naveg-api-vercel.vercel.app`, o deploy de produção, que aponta para o
`fluvi-app-dev` e não tem cliente. Detalhes no plano de ambientes do `naveg-front` (§3). E a variável só vale
com deploy novo.

**Dependência com aviso conhecido:** o `npm audit` aponta `uuid` < 11.1.1 (moderado), que o
`@google-cloud/storage` puxa por dentro do `firebase-admin`. A API não usa o Storage, e o defeito é na
geração de UUID v3/v5/v6 com buffer. O `npm audit fix` não resolve sem trocar a versão do `firebase-admin`;
fica registrado para a próxima atualização dele.

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
npm install @navegsistemas/domain@^0.2.0
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
  viagem, não a cada pedido. **Só a resposta boa leva o cabeçalho** — erro não fica em cache — e ela sai com
  `Vary: Origin`, para a borda não servir a uma origem a resposta de CORS de outra.
- **Sem concessão é `500`, e não um catálogo vazio.** A atuação `AGENCIAMENTO` ausente quer dizer
  `NAVEG_EMPRESA_ID` errado ou cadastro incompleto — defeito nosso, que um `200` vazio esconderia como "dia sem
  saídas".
- A resposta é `catalogoParaJson`: a concessão vai como listas, porque um `Set` vira `{}` no JSON. O totem lê
  com `catalogoDoJson`, que passa cada item pelos mesmos decodificadores que leem o Firestore.

### `POST /reservas` — passo 2

O corpo é **só o que o cliente pode afirmar**:

```json
{ "viagemId": "…", "data": "2026-10-14", "respostas": { }, "desafio": "token do Turnstile" }
```

O servidor deriva o resto e **não confia em mais nada**. As conferências vão da mais barata à mais cara:

1. **a origem** tem de estar em `ORIGENS_PERMITIDAS` → `403 ORIGEM_NAO_PERMITIDA`;
2. **o envio ligado** (Turnstile e Upstash configurados) → `503 ENVIO_INDISPONIVEL`;
3. **o corpo**, até 16 kB, na forma estrita do `pedidoDeReservaDoJson` do domínio → `413`/`400 CORPO_INVALIDO`;
4. **o limite por IP** → `429 LIMITE_EXCEDIDO`;
5. **o desafio**, no `siteverify` da Cloudflare, com a ação `reserva` → `403 DESAFIO_INVALIDO`;
6. **a travessia** `viagemId@data` entre as **ofertadas agora**, no catálogo recortado (guardado um minuto na
   instância). Inativa, fora da concessão ou já partida → `409 TRAVESSIA_INDISPONIVEL`;
7. **a montagem e a gravação**: o `enviarReserva` do domínio, com **código e instante do servidor** e
   `create` no Firestore — documento existente gera outro código, até cinco vezes. Incompleta ou incoerente →
   `422`, com as pendências tipadas. `codigo`, `criadoEm`, `status`, `agenciaId` e `observacao` mandados no
   corpo são ignorados.

Responde `201 { "codigo": "NVG-7K3QP2", "reserva": { … } }` — o documento como foi gravado, que o totem lê com
o mesmo codec que o aplicativo usa.

## Segurança

**Duas contas de serviço, e não uma.** O IAM do Firestore não distingue coleção: uma conta com papel de escrita
pode escrever em qualquer lugar do banco — inclusive em `passagens`. Por isso a rota do catálogo usa uma conta
com **`Cloud Datastore Viewer`**, e a de reservas **não tem papel no Firestore**: ela só assina o token do
usuário de serviço, e quem decide o que ele grava são as Rules do fluviapp. Um `set` escrito no lugar errado
falha em vez de gravar — e agora isso vale também para uma chave vazada.

O resto:

- **A escrita passa pelas Firestore Rules.** A API grava como o usuário de serviço `naveg-api`, e as Rules
  cercam o que ele cria: `RESERVADA`, do totem, da agência **do token**, com as chaves do contrato e o evento no
  mesmo lote. O domínio continua decidindo a coerência do pedido; as Rules seguram o que não pode passar mesmo
  que o código daqui erre. A leitura do catálogo continua pelo Admin SDK, com a conta que só lê.
- **Turnstile** no `POST`: sem App Check (que só existe para clientes Firebase), é o que responde *"tem gente
  do outro lado?"*.
- **Limite por IP** em Upstash Redis. Em memória não serve: a Vercel invoca funções, e cada instância teria o
  próprio contador.
- **CORS** com lista explícita de origens. Nunca `*`.
- **Segredos só de runtime**, nas variáveis de ambiente da Vercel. Nenhum prefixo público, nada no repositório.
- **Log sem dado pessoal.** Nome e telefone de quem reserva **não** vão para o log — nem em erro. O que
  identifica um pedido no log é o código da reserva.

## Configuração

Copie `.env.example` para `.env`. As cinco primeiras são obrigatórias, e a ausência de qualquer uma derruba a
partida com a lista inteira do que falta — não uma por vez. As três da proteção são **opcionais e juntas**, e a
chave Web também é opcional: faltando qualquer uma delas, o `POST /reservas` responde `503` e a partida avisa
qual falta.

| variável | o que é |
|---|---|
| `FIREBASE_PROJECT_ID` | o projeto Firebase do fluviapp |
| `FIREBASE_CONTA_DE_LEITURA` | JSON da conta de serviço com `Cloud Datastore Viewer` |
| `FIREBASE_CONTA_DE_ESCRITA` | JSON da conta de serviço que **assina o token** do usuário de serviço — sem papel no Firestore |
| `FIREBASE_WEB_API_KEY` | a `apiKey` do app Web do Firebase — o SDK cliente entra com ela. Não é segredo, mas é por ambiente |
| `NAVEG_EMPRESA_ID` | a empresa NAVEG no fluviapp, para achar `empresas/{id}/atuacoes/AGENCIAMENTO` |
| `ORIGENS_PERMITIDAS` | as origens do front, separadas por vírgula |
| `TURNSTILE_SECRET` | a chave **secreta** do widget do Turnstile (em dev, a de teste: `1x0000000000000000000000000000000AA`) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | o Redis do limite por IP; o token também é o sal do resumo do IP |

## As contas de serviço

**Projeto: `fluvi-app-dev`, e tudo é dev por enquanto** (decisão de 2026-09-23). É o único projeto que o
aplicativo conhece. Quando houver um de produção, **nada daqui migra**: contas novas, chaves novas, variáveis
novas — e as chaves de dev nunca entram no ambiente de produção.

| conta | papel | quem usa | variável |
|---|---|---|---|
| `naveg-api-leitura@fluvi-app-dev.iam.gserviceaccount.com` | `roles/datastore.viewer` | `GET /catalogo`, **e** a conferência do catálogo dentro do `POST /reservas` | `FIREBASE_CONTA_DE_LEITURA` |
| `naveg-api-escrita@fluvi-app-dev.iam.gserviceaccount.com` | **nenhum** — só assina o token de serviço (hoje ainda com `roles/datastore.user`, a remover: ver "Retomar daqui") | a gravação de reservas, **sob as Rules** | `FIREBASE_CONTA_DE_ESCRITA` |

O `POST` também lê o catálogo, e lê **com a conta de leitura**, pelo mesmo adaptador e o mesmo cache do `GET`.
A de escrita aparece numa linha do código só — como o IAM não separa coleção, é o menor lugar possível para
um engano gravar em `passagens`.

**Não use o botão "Gerar nova chave privada" do console do Firebase.** Ele gera chave da
`firebase-adminsdk-…`, que administra o projeto inteiro. As duas contas se criam no console do **Google Cloud**:

1. `console.cloud.google.com`, projeto `fluvi-app-dev` → **IAM e administrador → Contas de serviço → Criar**;
2. ID `naveg-api-leitura`; em "Conceder acesso", **só** o papel *Cloud Datastore Viewer*;
3. na conta criada, **Chaves → Adicionar chave → JSON**;
4. repetir com `naveg-api-escrita`, **sem papel nenhum** — ela só assina o token de serviço, e isso não pede IAM.

Ou, com o `gcloud`:

```bash
P=fluvi-app-dev
gcloud iam service-accounts create naveg-api-leitura --project=$P --display-name="API da agência: leitura do catálogo"
gcloud iam service-accounts create naveg-api-escrita --project=$P --display-name="API da agência: gravação de reservas"
gcloud projects add-iam-policy-binding $P --member="serviceAccount:naveg-api-leitura@$P.iam.gserviceaccount.com" --role=roles/datastore.viewer
# a de escrita NÃO ganha papel no Firestore: ela só assina o token de serviço (a P3). Para tirar o que já tem:
# gcloud projects remove-iam-policy-binding $P --member="serviceAccount:naveg-api-escrita@$P.iam.gserviceaccount.com" --role=roles/datastore.user
gcloud iam service-accounts keys create leitura.serviceaccount.json --iam-account=naveg-api-leitura@$P.iam.gserviceaccount.com
gcloud iam service-accounts keys create escrita.serviceaccount.json --iam-account=naveg-api-escrita@$P.iam.gserviceaccount.com
```

Depois:

- o **conteúdo** de cada JSON vai para a variável dele na Vercel, marcada como *Sensitive*; o arquivo baixado
  é apagado em seguida. Nenhum JSON de conta passa pelo repositório — ele é público;
- nenhuma das duas ganha Editor, Owner ou papel de Firebase Admin;
- a chave não expira sozinha: troca a cada 90 dias, ou na hora, se houver suspeita;
- **o `NAVEG_EMPRESA_ID`** é o id do documento da NAVEG em `empresas` — o que tem `atuacoes/AGENCIAMENTO`.

A chave JSON é a escolha da Fase 1, porque é o que o `config.ts` já lê. A alternativa sem chave — a Vercel se
identificando ao Google por OIDC (Workload Identity Federation) — fica para o endurecimento, e é o que
aposentaria estas duas chaves.

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

E o front não depende desta API para mexer na tela: com `PUBLIC_URL_DA_API=demonstracao`, o totem roda contra
o catálogo de demonstração dele, com a faixa dizendo que as saídas são fictícias.

## Cenários

`vitest`, e a régua é a do `naveg-front`: o app é **montado com a configuração e as portas**, então nenhum
cenário precisa de variável de ambiente, de rede ou de Firestore. O adaptador do Firestore depende de uma
interface mínima (`collection().get()`, `doc().get()`), e um cenário a cumpre com um objeto — conferindo os
caminhos e a decodificação. O emulador, com as Rules do fluviapp, entra no passo 2.

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
