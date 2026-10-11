---
name: retomar
description: Retoma o projeto NAVEG (naveg-api-vercel e naveg-front) do ponto onde parou. Usar quando o PO perguntar "onde paramos?", "o que falta?" ou abrir uma sessão nova na API querendo continuar.
---

# Retomar

A skill completa mora no `naveg-front`, porque o plano e o estado são um só para os dois repositórios.
Ler `../naveg-front/.claude/skills/retomar/SKILL.md` e seguir. Se o checkout do front não estiver ao lado,
cloná-lo (`gh repo clone navegsistemas/naveg-front ../naveg-front`) ou, no mínimo, ler a issue fixada "Onde
paramos" dos dois repositórios (`gh issue list --label onde-paramos`), `gh pr list` nos dois e rodar o
`npm run verify` na `main` atualizada daqui.
