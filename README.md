# Claude Low Cost

Camada local para cortar o gasto de API do Claude Code numa VM sob NDA. Nada aqui chama serviço externo: os modelos locais rodam em `llama-server` preso em loopback, e um teste (`packages/core/test/config.test.ts`) falha se alguma config apontar para fora.

Plano completo: fases 0–6, cada uma com um gate de go/no-go baseado em número.

## Estado

| Fase | O quê | Estado |
|---|---|---|
| 0 | `lcc usage`: de onde vem o gasto, a partir dos transcripts locais | pronto |
| 1 | llama-server + `lcc doctor` / `lcc bench` | a fazer |
| 2 | roteamento de modelo por subagent + corte de output | a fazer |
| 3 | juiz local compatível com Jev | a fazer |
| 4 | `code_search` local para exploração | a fazer |
| 5 | review preliminar local | a fazer |

## Uso (Fase 0)

```sh
npm install
npm run build
node packages/cli/dist/main.js usage --since 2026-10-01          # tabela
node packages/cli/dist/main.js usage --since 2026-10-01 --json   # para outras ferramentas
```

Opções: `--root` (padrão `~/.claude/projects`), `--pricing` (padrão `config/pricing.json`), `--project <trecho>` e `--top N`.

O custo é **equivalente à API**: tokens de `message.usage` vezes a tabela em `config/pricing.json`. Confira os preços na página oficial antes de confiar no total. Modelos fora da tabela aparecem como `UNPRICED` e não somam no total.

O relatório mostra:
- **By token class**: se o dinheiro vai em reler contexto (cache read), em escrever cache ou em output. É isso que diz qual alavanca puxar.
- **avg ctx**: tamanho médio do prompt por requisição, ou seja, o que cada turno paga para reler.
- **By agent type**: `main` contra cada tipo de subagent (o tipo vem do `.meta.json` do subagent).
- **Tool outputs**: quais ferramentas despejam mais texto no contexto, por agente.

## Desenvolvimento

```sh
npm run typecheck
npm test
```
