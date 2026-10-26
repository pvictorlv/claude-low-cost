# Fase 2: cortar o gasto sem LLM local

Na VM, **~68% do custo é cache read**: cada requisição relê o prompt inteiro. Esse prompt tem duas partes:

1. **Base fixa** (~65–70k tokens): system prompt, definições de ferramentas, CLAUDE.md, lista de skills e de agentes. Ela é paga em *toda* requisição, de *todo* agente. Num subagent curto, ela responde por 75–87% da releitura.
2. **Crescimento da conversa**: algumas sessões principais passam de 1.000 requisições com contexto médio acima de 250k.

As alavancas abaixo atacam cada parte. A ordem é **medir → simular → aplicar uma → medir de novo**.

## 0. Medir e simular antes de mexer

```sh
node packages/cli/dist/main.js usage --since <data> --top 12      # retrato atual
node packages/cli/dist/main.js whatif --since <data> \
  --cut-baseline 30k \
  --cap-context 150k@^main$ \
  --swap-model "claude-haiku-5-5@^(publish|run|prep)-"            # quanto cada alavanca valeria
```

O `whatif` recalcula o preço das requisições já gravadas. Ele dá a ordem de grandeza, não o resultado: ver as premissas em `packages/cli/src/usage/whatif.ts`. Ele **não** diz se o modelo mais barato dá conta da tarefa; isso só um teste mostra.

## 1. Descobrir do que a base é feita

Na VM, numa sessão nova e no diretório de trabalho de sempre:

```
/context all
```

Ele mostra os tokens por categoria e por ferramenta MCP carregada. Anote os maiores itens. Os candidatos de sempre:

| Item | Como reduzir |
|---|---|
| **Memory files** (CLAUDE.md) | Normalmente o maior item que dá pra cortar. Siga [`enxugar-claude-md.md`](enxugar-claude-md.md). Subagents mecânicos podem usar `omitClaudeMd: true`. |
| Schemas de ferramentas MCP | Normalmente já são adiados: no `/context all` aparecem como "loaded on-demand", e as instruções de MCP somam pouco. Só vale mexer se algum servidor tiver `alwaysLoad: true` ou se `ENABLE_TOOL_SEARCH=false`. |
| Skills e plugins | Cada skill põe ~50–500 tokens na base. Desinstale os plugins que ninguém usa. Os de uso diário raramente compensam o corte. |
| Agentes definidos | Cada definição entra na lista de agentes (~100 tokens). Pouco ganho. |
| System tools (~20k) | Ferramentas nativas. Não dá para tirar da conversa principal; só caem em subagents com `tools:` restrito. |

**Meta**: base abaixo de 40k. O efeito aparece na coluna `baseline` do `lcc usage`.

## 2. Subagents: modelo e ferramentas certos

O `general-purpose` herda **todas** as ferramentas e o modelo da sessão. Os subagents de nome livre (`publish-*`, `run-*`, `prep-*`, `writer-*`) são `general-purpose` com outro nome, ou seja, Sonnet com a base cheia.

Em `claude/agents/` há modelos para copiar para `.claude/agents/` do projeto, adaptando ao fluxo do time:

| Arquivo | Para quê | Modelo |
|---|---|---|
| `runner.md` | Executar passos definidos: rodar testes e scripts, publicar resultados | `haiku` |
| `scout.md` | Buscar e ler código ou itens, só leitura, e devolver um resumo curto | `haiku` |
| `browser-qa.md` | Teste de navegador com Playwright, que só esse agente carrega | `sonnet` |

Por que funciona: no Haiku 5.5 a releitura custa $0,01/M, contra $0,20/M no Sonnet 5.5, e entrada e saída são ~20× mais baratas. Restringir `tools` e usar `mcpServers` inline tira schemas que o agente não usa. (A documentação não promete quantos tokens isso economiza: confira na coluna `baseline`.)

Para que o time realmente use esses agentes, ponha uma linha no CLAUDE.md do projeto, por exemplo: *"Para executar testes ou publicar resultados, delegue ao agente `runner`. Para investigar, use `scout`."*

O jeito mais simples, sem criar agente nenhum: o modelo de cada chamada de subagent tem precedência sobre todo o resto. Então uma regra no CLAUDE.md já basta:

> Subagents: para tarefas mecânicas com passos já definidos (rodar um caso de teste, publicar resultado, preencher campos, abrir bug a partir de dados prontos), chame o subagent com `model: haiku`. Use Sonnet só para investigar, decidir ou escrever código.

Alternativa global, mais agressiva: `CLAUDE_CODE_SUBAGENT_MODEL=haiku` vira o modelo padrão de qualquer subagent sem `model` próprio. Teste antes num dia de trabalho normal. Se a qualidade cair, volte atrás.

## 3. Sessões longas

A sessão principal mais cara custou $124 sozinha. Hábitos e configuração:

- **`/clear` ao trocar de tarefa.** É a alavanca mais barata que existe: zera a conversa e mantém só a base.
- **`/compact` ao fim de cada etapa** de uma tarefa longa, com instrução do que preservar (`/compact mantenha os IDs dos itens e a lista de pendências`).
- **Compactação automática mais cedo.** Veja a linha "Auto-compact window" no `/context all`. Em modelos de 1M de contexto ela pode ser de **1M**: a sessão cresce até perto de 1M antes de compactar, e cada turno relê tudo isso. Configure `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` (aceita de 100000 a 1000000) no `env` do `~/.claude/settings.json`. Para ajuste fino há também `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<1-100>`, que só consegue *baixar* o limiar. Compactar cedo demais perde detalhe; comece em 200k e meça.
- Para subagents longos: `autoCompactWindow` no frontmatter do agente.

## 4. Saídas grandes de ferramentas (efeito menor na VM)

Na VM, as saídas de ferramentas são pequenas perto da releitura. Se uma ferramenta específica aparecer no topo da tabela "Tool outputs":

- `MAX_MCP_OUTPUT_TOKENS` (padrão 25.000) limita a resposta de MCPs. Algumas respostas de work item passam de 12k tokens.
- `BASH_MAX_OUTPUT_LENGTH` (padrão 30.000 caracteres).

## 5. Configuração de exemplo

`claude/settings.example.json` junta as variáveis acima. Copie só o que for aplicar agora, uma alavanca por vez, para o `lcc usage` conseguir atribuir o efeito.

## Como saber se funcionou

1. Anote o `lcc usage --since <dia da mudança>` de uma semana normal antes e de uma depois.
2. Compare: `baseline` por agente, `avg ctx`, `$ por requisição` e o total.
3. Pergunte ao time se algo piorou: retrabalho, subagent que errou, compactação que perdeu contexto. Uma economia que gera retrabalho não é economia.

Referências (documentação do Claude Code): `sub-agents`, `env-vars`, `mcp`, `prompt-caching` e `costs` em https://code.claude.com/docs/en/.
