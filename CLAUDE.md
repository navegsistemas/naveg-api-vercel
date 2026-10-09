# naveg-api-vercel — o que o Claude precisa saber

Este arquivo e as skills em `.claude/skills/` são o contexto do projeto para o Claude Code, no repositório para
valer em qualquer máquina. **O contexto comum mora no `naveg-front`** (`../naveg-front/CLAUDE.md`): quem é o PO,
como o trabalho anda, as lições técnicas. Ler aquele primeiro; aqui está só o que é da API.

## Quem é quem, em uma linha

Matheus é **analista de sistemas e de requisitos, e PO**: decide produto e regra; a implementação é do Claude.
Levar a ele o que muda produto, prazo, custo, risco ou dado pessoal, com recomendação.

## Onde mora o estado

- o **"Retomar daqui"** do [README](README.md) — o que está no ar, o que espera promoção;
- o plano, que é um só para front e API: `../naveg-front/docs/plano-de-implementacao.md` (os passos 9 e 10 são
  os 1 e 2 daqui);
- a operação: `../naveg-front/docs/RUNBOOK.md` (§5: promover e voltar atrás).

As skills `retomar`, `salvar-onde-paramos`, `secao-de-ui` e `preparar-maquina` estão em
`../naveg-front/.claude/skills/`. Aqui há um atalho para `retomar` e a skill própria da API, `promover-homologacao`.

## O que só o PO faz

- **Promover** (`vercel promote`) e voltar atrás em produção. O merge na `main` gera um *Preview*; a homologação é
  o deploy de *Production*. O Claude prepara a lista do que vai junto e confere depois — por
  `gh api repos/navegsistemas/naveg-api-vercel/deployments?environment=Production` e `vercel logs` —, sem
  sondar produção por conta própria.
- Trocar chaves das contas de serviço (a primeira vence por volta de 2026-12-22) e variáveis na Vercel.

## Regras da API que não se negociam

- **Log sem dado pessoal**: nome e telefone nunca vão ao log, nem em erro. O pedido se identifica pelo código.
- **A regra é do `@navegsistemas/domain`** (publicado do `naveg-front`), não daqui. Mudou a regra, muda lá e sobe
  a versão.
- A conta de escrita **não tem papel no Firestore**: ela só assina o token do usuário de serviço, e quem decide
  o que grava são as Rules do fluviapp-kmp. Não "consertar" um erro de gravação dando papel a ela.
- Variável nova na Vercel só vale com deploy novo.

## Lições técnicas

- `NPM_TOKEN` = `gh auth token` (o domínio vem do GitHub Packages). Sem ele, `$env:NPM_TOKEN = gh auth token`.
- **Vitest pelo PowerShell**; pelo Git Bash com cwd `/c/...` quebra.
- `npm run test:emulador` lê as Rules do checkout do KMP (`FLUVIAPP_KMP`, padrão
  `~/AndroidStudioProjects/fluviapp-kmp`) e pede Java 17 no PATH. Não mexer no checkout do KMP: ele pode estar
  num branch em andamento.
- O `vercel link` acrescenta `.env*` ao `.gitignore` — desfazer (a regra daqui já cobre e mantém o `!.env.example`).
- Arquivos em CRLF: troca multilinha por script falha; usar a ferramenta de edição.
- Pendência de outro repositório vira **issue lá**, não nota aqui.

## Comandos

`npm run verify` (typecheck + vitest) · `npm run test:emulador` · `npm run dev` (`vercel dev`, com `.env.local`).

## Parado de propósito

O major do TypeScript 7 (PR #10) — o mesmo caso do front #13; ver `../naveg-front/CLAUDE.md`.
