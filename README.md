# Claude Low Cost

Camada local para cortar o gasto de API do Claude Code numa VM sob NDA. Nada aqui chama serviço externo: os modelos locais rodam em `llama-server` preso em loopback, e um teste (`packages/core/test/config.test.ts`) falha se alguma config apontar para fora.

Plano completo: fases 0–6, cada uma com um gate de go/no-go baseado em número.

## Estado

| Fase | O quê | Estado |
|---|---|---|
| 0 | `lcc usage` (de onde vem o gasto) + `lcc whatif` (quanto cada alavanca valeria) | pronto |
| 2 | base menor, modelo certo por subagent, sessões mais curtas: [playbook](docs/fase2-playbook.md) + `claude/` | pronto para aplicar |
| 1 | llama-server + `lcc doctor` / `lcc bench` | em espera |
| 3 | juiz local compatível com Jev | em espera |
| 4 | `code_search` local para exploração | em espera |
| 5 | review preliminar local | em espera |

As fases com LLM local (1, 3, 4 e 5) estão em espera porque a medição na VM mostrou que ~68% do custo é reler contexto (a base fixa e as sessões longas). Saídas de ferramentas, exploração e review, que é o que um modelo local substituiria, somam pouco. Voltam à pauta se, depois da Fase 2, o `lcc usage` mostrar gasto que elas consigam atacar.

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

### Perfil de contexto

A tabela "Context profile" separa, por tipo de agente:
- a **base**: o prompt da primeira requisição, antes de qualquer trabalho;
- o **pico** a que o prompt chega;
- quanto da releitura vai só para a base.

Base alta pede alavancas de configuração. Pico alto pede sessões mais curtas.

## Simulação (`lcc whatif`)

```sh
node packages/cli/dist/main.js whatif --since 2026-10-01 \
  --cut-baseline 30k \
  --cap-context 150k@^main$ \
  --swap-model "claude-haiku-5-5@^(publish|run|prep)-"
```

O comando recalcula o preço das requisições já gravadas sob cada mudança, depois todas juntas. São estimativas: as premissas estão em `packages/cli/src/usage/whatif.ts`.

## Desenvolvimento

```sh
npm run typecheck
npm test
```
