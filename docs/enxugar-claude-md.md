# Enxugar o CLAUDE.md global

O `~/.claude/CLAUDE.md` entra em **toda** requisição: de toda sessão, de todo projeto, de todo subagent que não tenha `omitClaudeMd: true`. Com 17k tokens, ele sozinho é cerca de um terço da base fixa.

A regra: no CLAUDE.md global fica só o que vale para *toda* sessão. Procedimentos usados em certas tarefas viram **skills**, e uma skill põe na base só a `description` (~100 tokens). O conteúdo carrega quando a skill é usada.

## Como fazer

Rode isto **no Claude Code da própria máquina**, para que o conteúdo do arquivo não saia dela. Cole o prompt abaixo numa sessão nova:

```
Quero reduzir o custo de contexto do meu ~/.claude/CLAUDE.md sem perder nenhuma regra.
Ele é carregado em toda requisição de toda sessão e de todo subagent.

1. Faça backup em ~/.claude/CLAUDE.md.bak.
2. Leia o arquivo e classifique cada seção em:
   A. vale para toda sessão, em qualquer projeto;
   B. vale só para um projeto ou repositório específico;
   C. é um procedimento ou referência usado só em certas tarefas;
   D. está duplicado, obsoleto ou é explicação longa de algo que cabe numa linha.
3. Me mostre uma tabela (seção, classe, tokens aproximados, destino) e ESPERE minha aprovação.
4. Depois de aprovado:
   - A: reescreva de forma concisa no ~/.claude/CLAUDE.md. Meta: até 4k tokens.
   - B: mova para o CLAUDE.md do projeto correspondente.
   - C: crie uma skill por procedimento em ~/.claude/skills/<nome>/SKILL.md, com
     frontmatter `name` e uma `description` que diga claramente QUANDO usar.
   - D: só liste. Não apague nada de D sem eu confirmar item por item.
5. No final, rode /context e me diga quantos tokens os memory files ocupam agora.
```

Ao terminar, aproveite para incluir no CLAUDE.md novo a regra de modelo dos subagents (`fase2-playbook.md`, seção 2).

## Como medir

- Na hora: `/context` → "Memory files".
- Depois de uma semana: `lcc usage --since <dia da mudança>` → coluna `baseline` do "Context profile".
