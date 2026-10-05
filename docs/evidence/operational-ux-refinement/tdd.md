# TDD evidence — operational UX refinement (2026-10-05)

Branch `feat/ux-playbook-refinement`, base `deskflow/main@2e3c10b08`.

## RED (antes de qualquer código de produto)

Comando:

```bash
corepack pnpm vitest run lib/kanban/filtros-ativos.test.ts components/kanban/EmptyPorFiltro.test.tsx components/kanban/KanbanBoard.test.tsx "app/app/pipelines/[id]/_client.test.tsx"
```

Saída (resumo real):

```
 Test Files  4 failed (4)
      Tests  4 failed | 2 passed (6)
```

- `lib/kanban/filtros-ativos.test.ts` — falhou: módulo `./filtros-ativos` não existia.
- `components/kanban/EmptyPorFiltro.test.tsx` — falhou: módulo `./EmptyPorFiltro` não existia.
- `components/kanban/KanbanBoard.test.tsx` — 3 falhas (notice de ausência, notice filtrado, rótulo de sem-etapas); 2 verdes (loading `BoardSkeleton` e erro incumbentes — pin de comportamento existente).
- `app/app/pipelines/[id]/_client.test.tsx` — 1 falha: `getByText("Nenhum lead com esses filtros")` não encontrado.

## GREEN (mesma alvo, após implementação mínima)

```bash
corepack pnpm vitest run lib/kanban/filtros-ativos.test.ts components/kanban/EmptyPorFiltro.test.tsx components/kanban/KanbanBoard.test.tsx "app/app/pipelines/[id]/_client.test.tsx"
```

```
 Test Files  4 passed (4)
      Tests  19 passed (19)
```

## Testes relacionados existentes

```bash
corepack pnpm vitest run tests/unit/i18n-espanhol-cobre-a-tela.test.ts app/app/kanban/_client.test.tsx lib/kanban/card-state.test.ts
```

```
 Test Files  1 failed | 2 passed (3)
      Tests  2 failed | 45 passed (47)
```

As 2 falhas do guardião i18n foram reproduzidas na worktree limpa do commit
`2e3c10b08` (não apenas inferidas do diff): cinco chaves sem `es` em
`app/app/ai/agents/[id]/_components/TestPanel.tsx`, `components/ai/ChaveDeConhecimento.tsx`
e `components/inbox/AcervoSearch.tsx`, mais três textos crus em
`app/auth/email/page.tsx`. O comando de base
`corepack pnpm exec vitest run tests/unit/i18n-espanhol-cobre-a-tela.test.ts --maxWorkers=2`
produziu `2 failed | 17 passed (19)`, exit 1. As
strings novas desta fatia ("Nenhum lead com esses filtros", "Motivo de perda",
"Valor mínimo", "Valor máximo", "Modo: OU") têm `es` em
`lib/i18n/dicionario.ts`.

## Typecheck / lint

```bash
corepack pnpm typecheck   # tsc --noEmit -p tsconfig.typecheck.json → limpo, sem saída de erro
corepack pnpm lint        # 0 errors, 474 warnings (warnings pré-existentes no repo)
```

`components/kanban/KanbanBoard.tsx` mantém apenas os 2 warnings
`react-hooks/exhaustive-deps` pré-existentes (linha 166, o condicional `data`).

## E2E

BLOQUEADO: não há Supabase local disponível nem `.env.e2e`. A execução real de
`corepack pnpm test:e2e tests/e2e/kanban-owner-filter.spec.ts --grep "busca sem resultado"`
saiu 1 antes de coletar testes: `Falta o .env.e2e — rode pnpm e2e:env`.
A guarda que impede usar produção não foi contornada.
Dois casos (1440px/390px) foram acrescentados à spec existente; estão typechecados,
mas NÃO executados. Capturas interinas usam componentes reais com dados sintéticos
em harness Vite, sem backend; não equivalem à instalação fresca.

## Revisão direta e ciclos adicionais RED/GREEN

Após o pedido para continuar sem agentes, a revisão direta encontrou:

- Modo OU sem etiquetas (ou com uma só) não restringe resultados. RED:
  `lib/kanban/filtros-ativos.test.ts` recebeu `["Modo: OU"]` quando esperava `[]`.
- O aviso não tinha uma região de status. RED: `Unable to find ... role "status"`.
- A ação do aviso precisava de um grupo acessível próprio, pois a barra também
  oferece "Limpar filtros". RED: ausência de `role "group"` com o nome do aviso.
- Limpar fora da barra deixava o campo antigo. RED:
  `FilterBar.test.tsx`: esperado vazio/"clínica", recebido "padaria".

O aviso agora é uma faixa sem ícone decorativo, com texto de status e ação ao lado
no desktop; a ação fica abaixo no mobile. As colunas e drop targets continuam no
board. `FilterBar` reconcilia a busca aplicada antes do commit, sem restaurar a
busca antiga pelo debounce.

GREEN do conjunto relevante:

```text
corepack pnpm vitest run lib/kanban/filtros-ativos.test.ts components/kanban/EmptyPorFiltro.test.tsx components/kanban/FilterBar.test.tsx components/kanban/KanbanBoard.test.tsx "app/app/pipelines/[id]/_client.test.tsx" app/app/kanban/_client.test.tsx lib/kanban/card-state.test.ts --maxWorkers=2
Test Files  7 passed (7)
Tests       52 passed (52)
```

`corepack pnpm typecheck` terminou sem erros. ESLint nos arquivos alterados:
`0 errors, 2 warnings`, ambos no condicional `data` incumbente de `KanbanBoard`.
`lint:channels` e `lint:role-rank` passaram; `release:conferir` validou o fragmento
em modo de conferência, sem escrever CHANGELOG ou cortar versão.

## Suíte completa: não aprovada

`corepack pnpm test:unit` foi executado, apresentou falhas e foi interrompido
após 1657 segundos, antes do resumo final. Não há total completo nem PASS.
Falhas observadas incluíram i18n, namespace de imagens, guardas de release,
scripts de instalação/CI, varreduras estruturais, branding, tokens, PDFs de LGPD,
agenda e configuração de provedores. A base limpa comprovou somente as duas
falhas de i18n; as demais não foram todas comparadas contra a base.
Mensagens do ambiente incluíram `sed: is_mb_char: mbrtowc ... returned 3` e
timeouts. Não se atribui tudo ao Windows nem ao produto sem reprodução própria.

## Gates finais executados diretamente

- `corepack pnpm build`: exit 0 na segunda execução (245 segundos), incluindo
  compilação, TypeScript e geração de páginas. O build sem backend local registrou
  avisos de fallback de marca/módulos (`fetch failed`); não prova conexão com banco.
  `SENTRY_AUTH_TOKEN` foi esvaziado somente no processo para evitar upload externo.
- `corepack pnpm lint`: exit 0, `475 problems (0 errors, 475 warnings)`.
  O relatório de cobertura gerado adicionou um aviso em `coverage/block-navigation.js`;
  não afirmar que todos os avisos são código preexistente.
- `corepack pnpm vitest run lib/kanban/filtros-ativos.test.ts components/kanban/EmptyPorFiltro.test.tsx --maxWorkers=2 --coverage --coverage.include=lib/kanban/filtros-ativos.ts --coverage.include=components/kanban/EmptyPorFiltro.tsx`:
  `2 passed`, `16 passed`, exit 0. Cobertura 100% de statements, branches,
  functions e lines SOMENTE nesses dois arquivos novos, não no CRM inteiro.
- `git diff --check`: sem saída de erro.
- Consulta read-only da main remota: `60f510c27` no momento da conferência;
  quatro commits de ícones/transições após a base da fatia. Não foram sobrescritos
  nem incorporados automaticamente à árvore com alterações em andamento.

## Estado de integração

Esta é uma fatia do Kanban, não um redesenho completo do CRM. Não houve alteração
de schema, autorização, branding, navegação nem atualização da instalação.
A main remota recebeu mudanças concorrentes; a branch ainda precisa ser
atualizada e verificada sobre o resultado integrado antes de publicação.
Sem commit, push, merge ou deploy nesta etapa.
