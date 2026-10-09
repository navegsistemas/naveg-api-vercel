---
name: promover-homologacao
description: Prepara e confere a promoção da naveg-api-vercel para a homologação (o deploy de Production na Vercel). Usar quando o PO falar em promover, "subir a API", "levar para a homologação", ou quando um merge na main da API precisar chegar ao front de homologação.
---

# Promover a API para a homologação

O merge na `main` gera um deploy *Preview*. A homologação é o deploy de *Production*
(`naveg-api-vercel.vercel.app`, provisório até os domínios). **Promover é do PO** — o Claude prepara antes e
confere depois. Referência: `../naveg-front/docs/RUNBOOK.md` §5.

## Antes — o que vai junto

1. Qual deploy está na homologação hoje:
   `gh api repos/navegsistemas/naveg-api-vercel/deployments?environment=Production --jq '.[0] | {sha, created_at}'`
2. O que entra: `git log --oneline <sha de hoje>..origin/main` — listar os PRs para o PO, com o risco de cada um
   (troca de ponto de entrada, de dependência major, de regra de proteção).
3. A fumaça do Preview passou no CI (`gh run list -w fumaca.yml -L 3`).
4. Variável nova? Conferir que já está no escopo *Production* da Vercel — senão o build promovido sobe sem ela.

Entregar ao PO: o comando (`vercel promote <url do deploy do merge>`), a lista do que vai e o que conferir.

## Depois — conferir (logo em seguida)

1. O totem de homologação do front (`naveg-front-agencia.vercel.app`) carrega as saídas (`GET /catalogo`).
2. **Uma reserva gravada** no totem chega ao painel do KMP (o PO faz e confirma).
3. `vercel logs` sem erro novo — em especial `auth/invalid-custom-token` (é o login do serviço, não o banco;
   ver o README) e `503 ENVIO_INDISPONIVEL` (falta variável da proteção).
4. Se algo falhar: o PO roda `vercel rollback` (volta ao deploy anterior, sem rebuild).

## Ao fim

Atualizar o "Retomar daqui" da API (o deploy que está na homologação agora) e tirar o "atenção na próxima
promoção" do RUNBOOK §5 do front — num PR em cada repositório.
