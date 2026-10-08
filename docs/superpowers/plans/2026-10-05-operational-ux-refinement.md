# Operational UX Refinement — plano de implementação

## Atualização de execução

- [x] Helper: nomear somente restrições efetivas; OU requer múltiplas etiquetas.
- [x] Aviso compacto, grupo acessível e status sem ação dentro do anúncio.
- [x] Preservar colunas/drop targets e distinguir ausência de etapas/filtro/leads.
- [x] Conectar limpar à URL e reconciliar o campo em `FilterBar.tsx`.
- [x] Acrescentar `FilterBar.test.tsx` e casos na spec E2E já existente.
- [x] Prova de componentes em browser desktop/mobile com dados sintéticos.
- [ ] Suíte completa aprovada: execução apresentou falhas e foi interrompida.
- [ ] E2E autenticado: bloqueado por Supabase local/`.env.e2e` indisponível.
- [ ] Atualização contra main concorrente e verificação do resultado integrado.
- [ ] Publicação autorizada; nenhum commit/push/merge/deploy foi feito.

As decisões finais de refinamento da emenda da spec prevalecem sobre os exemplos
iniciais. Screenshots ficam em `evidence/operational-ux-refinement/`, não em docs.
Não classificar o CRM inteiro como pronto por esta fatia.

> Spec: `docs/superpowers/specs/2026-10-05-operational-ux-refinement-design.md`.
> Execução **inline** nesta sessão (TDD, um builder, fatias sequenciais). Branch
> `feat/ux-playbook-refinement`, worktree `.worktrees/deskflow-crm-ux-playbook`, base `deskflow/main@2e3c10b08`.

**Goal:** estados operacionais honestos no Kanban (vazio vs filtrado vs carregando vs sem etapas),
com filtros ativos nomeados e saída clara — sem remover colunas, drop targets ou affordances de
etapa vazia. Inbox já verificado adequado; nenhuma mudança lá.

**Arquitetura:** helper puro testado (`lib/kanban/filtros-ativos.ts`) → componente de vazio
reusável (`components/kanban/EmptyPorFiltro.tsx`) → notice no nível do board
(`KanbanBoard.tsx`) → ligação na página (`pipelines/[id]/_client.tsx`) → dicionário `es`.
Sem migration, sem rota nova, sem CSS global.

**Stack:** Next.js 16 App Router · Zod · Supabase (RLS) · TanStack Query · Vitest · Testing Library · Playwright.

## Global Constraints

- Um builder só, fatias sequenciais; um escritor por arquivo; sem concorrência de builders.
- RED antes de código de produto; GREEN mínimo; reviewer + QA antes de declarar pronto.
- Colunas, drop targets e "vazio" por coluna (`StageColumn.tsx:244`) preservados sempre; o aviso
  é notice ACIMA das colunas, nunca substitui o board.
- Loading incumbente: página pulse "Carregando…", board `BoardSkeleton` — testes casam o incumbente.
- "Limpar filtros" só com `onLimparFiltros` fornecido — sem botão morto.
- Strings novas só com `es` em `lib/i18n/dicionario.ts` (`en` não existe no dicionário).
- Sem `console.log`; `pnpm typecheck` e `pnpm lint` zerados antes de cada commit.
- **E2E obrigatório para UI e BLOQUEADO** (sem Supabase local/`.env.e2e`): declarar bloqueado,
  nunca N/A nem "completo". Interim: harness visual de componente no browser (não equivale a VPS fresca).
- Capturas em `evidence/operational-ux-refinement/`, dados sintéticos apenas.
- Sem deploy/push até aprovação explícita.

## Estrutura de arquivos

| Arquivo | Ação | Dono |
|---|---|---|
| `lib/kanban/filtros-ativos.ts` | novo | builder (único) |
| `lib/kanban/filtros-ativos.test.ts` | novo | builder (único) |
| `components/kanban/EmptyPorFiltro.tsx` | novo | builder (único) |
| `components/kanban/EmptyPorFiltro.test.tsx` | novo | builder (único) |
| `components/kanban/KanbanBoard.tsx` | editar | builder (único) |
| `components/kanban/KanbanBoard.test.tsx` | novo | builder (único) |
| `app/app/pipelines/[id]/_client.tsx` | editar | builder (único) |
| `app/app/pipelines/[id]/_client.test.tsx` | novo | builder (único) |
| `lib/i18n/dicionario.ts` | editar | builder (único) |

## Fatias (sequenciais, TDD)

### Fatia 1 — helper de filtros ativos do kanban
- **RED**: `lib/kanban/filtros-ativos.test.ts` — sem filtros → `[]`; cada campo real de
  `LeadFilters` (`owner`, `status`, `tag` string e array, `tagMode`, `search`, `valueCentsMin/Max`,
  `overdueOnly`, `lostReason`, `lostCategory`) → rótulo; combinação → ordem estável.
  `pnpm vitest run lib/kanban/filtros-ativos.test.ts` → falha.
- **GREEN**: `lib/kanban/filtros-ativos.ts` — espelha `lib/inbox/filtros-ativos.ts`; cobre
  exatamente os campos reais; **não inventa** `unreadOnly`/`channel`/datas (não existem em
  `LeadFilters`).

### Fatia 2 — EmptyPorFiltro do kanban
- **RED**: `components/kanban/EmptyPorFiltro.test.tsx` — "Nenhum lead com esses filtros";
  lista filtros ativos; "Limpar filtros" chama `onLimpar`; sem `onLimpar` não renderiza botão.
  Padrão: `components/inbox/ConversationListItem.test.tsx`.
- **GREEN**: `components/kanban/EmptyPorFiltro.tsx` — espelha `components/inbox/EmptyPorFiltro.tsx`.

### Fatia 3 — KanbanBoard: notice acima das colunas
- **RED**: `components/kanban/KanbanBoard.test.tsx` —
  (a) `stages=[]` → "Nenhuma etapa configurada.";
  (b) zero leads sem filtro → notice "Nenhum lead nesta pipeline ainda." ACIMA das colunas,
  e as colunas/drop targets continuam renderizados;
  (c) zero leads + `filtrosAtivos=["Busca"]` → "Nenhum lead com esses filtros" + "Limpar filtros",
  colunas preservadas;
  (d) loading → `BoardSkeleton` incumbente; (e) erro → mensagem incumbente.
- **GREEN**: `components/kanban/KanbanBoard.tsx` — props `filtrosAtivos?: string[]` e
  `onLimparFiltros?: () => void`; notice no nível do board; colunas sempre renderizadas.

### Fatia 4 — página do pipeline liga os fios
- **RED**: `app/app/pipelines/[id]/_client.test.tsx` — com `filters.search` e zero leads,
  mostra "Nenhum lead com esses filtros"; "Limpar filtros" → `router.replace` sem query string.
- **GREEN**: `app/app/pipelines/[id]/_client.tsx` — `filtrosAtivos` via helper (useMemo);
  `onLimparFiltros = () => setFilters({ status: "all" })`.

### Fatia 5 — dicionário
- **RED**: rodar `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` antes — deve falhar ao faltar `es`.
- **GREEN**: `lib/i18n/dicionario.ts` — `es` para: "Nenhum lead com esses filtros",
  "Nenhuma etapa configurada.", "Nenhum lead nesta pipeline ainda." (se nova chave),
  "Responsável" (já existe), "Motivo de perda", "Categoria", "Status", "Busca" (existe),
  "Etiqueta" (existe), "Apenas atrasados" (existe), "Limpar filtros" (existe), "Ativos:" (existe).

## Verificação (gates)

```bash
pnpm vitest run lib/kanban/filtros-ativos.test.ts components/kanban/EmptyPorFiltro.test.tsx components/kanban/KanbanBoard.test.tsx "app/app/pipelines/[id]/_client.test.tsx"
pnpm typecheck && pnpm lint
pnpm test:unit
```

- Reviewer: diff + estados (vazio/filtrado/loading/erro/sem-etapas), colunas preservadas, foco,
  mobile, papéis (`podeGerenciar`).
- QA: harness visual de componente no browser como prova interina; **E2E real bloqueado**
  (sem Supabase local/`.env.e2e`) — registrar bloqueio, não N/A.
- Living System Checklist no PR: toda demanda tem próximo passo; vazio filtrado nomeia filtros
  e oferece saída; observabilidade inalterada.
