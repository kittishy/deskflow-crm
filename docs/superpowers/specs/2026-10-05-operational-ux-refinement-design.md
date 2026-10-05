# Operational UX Refinement — Design (2026-10-05)

## Emenda após revisão e prova de componente

Esta emenda prevalece sobre alternativas visuais abaixo: o aviso é uma faixa
compacta SEM ícone decorativo, com grupo acessível nomeado, texto `role="status"`
e botão fora da região de anúncio. Preserve o Button canônico: 44px em telas de
toque, compacto no desktop. Não acrescente outro painel/card ao quadro.

`components/kanban/FilterBar.tsx` e seu teste entram no escopo: limpar pelo aviso
deve limpar também o campo de busca e impedir reaplicação da busca antiga.
O modo OU só é nomeado quando há duas ou mais etiquetas normalizadas.
Os filtros são aplicados no cliente por `applyFilters`, não enviados ao servidor
pela página. A spec E2E existente `tests/e2e/kanban-owner-filter.spec.ts` recebe
casos desktop/mobile de filtro sem resultado e retorno por teclado.

Evidência visual vive em `evidence/operational-ux-refinement/`; evidência TDD em
`docs/evidence/operational-ux-refinement/tdd.md`. O harness de componentes não
substitui a jornada autenticada com Supabase local, atualmente bloqueada.

> Piloto aprovado: estados operacionais honestos (vazio vs filtrado vs carregando vs não selecionado),
> hierarquia consistente e filtros ativos visíveis em Inbox e Kanban. Base: `deskflow/main` @ `2e3c10b08`,
> branch isolada `feat/ux-playbook-refinement`. Escopo fora: finanças/MRR/projetos/auth/schema.

## Evidência medida (não aceita por afirmação)

- **Inbox já está coberto.** `components/inbox/ConversationList.tsx:116-152`: loading = skeletons;
  erro = mensagem + "Tentar novamente"; vazio por ausência = `EmptyInbox` (só quando
  `filtrosAuxiliaresAtivos(filters).length === 0`); vazio por filtro = `EmptyPorFiltro`
  (`components/inbox/EmptyPorFiltro.tsx`) com nomes dos filtros ativos e "Limpar filtros",
  renderizado DENTRO do return (nunca `return` precoce — preserva "Carregar mais").
  Não selecionado: `components/inbox/InboxLayout.tsx:637-643` ("Selecione uma conversa" + "Ou navegue com J e K").
- **Kanban tem o defeito demonstrado.** `components/kanban/KanbanBoard.tsx:259-265`:
  `data.stages.length === 0` mostra "Nenhum lead nesta pipeline ainda." — rótulo errado para
  "sem etapas". Pior: com etapas presentes e filtros zerando os leads, o quadro renderiza
  todas as colunas com "vazio" (`components/kanban/StageColumn.tsx:244`) — **indistinguível de
  pipeline genuinamente vazia**. Não há resumo de filtros ativos na área do quadro;
  `components/kanban/FilterBar.tsx:381-398` só oferece "Limpar filtros".
- `app/app/kanban/_client.tsx:429-458`: `EmptyPipeline` com CTA "Criar meu primeiro funil" — adequado.
- Padrão a imitar: `lib/inbox/filtros-ativos.ts` (deriva do MESMO objeto de filtros que foi ao
  servidor — uma fonte só) e `EmptyPorFiltro` (vazio que não mente).

## Decisão

Inbox: **nenhuma mudança** — o piloto já está adequado; registrar como verificado.
Kanban: trazer o mesmo contrato honesto — estado filtrado-vazio explícito com filtros ativos
nomeados e ação de limpar, separado de vazio-por-ausência, loading e erro.

## Preservação de operação (não negociável)

- Com zero leads (com ou sem filtro), o quadro **mantém todas as colunas, drop targets e
  affordances de etapa vazia** (`StageColumn` "vazio"). O aviso de estado é um **notice no
  nível do quadro, ACIMA das colunas** — nunca substitui o board, nunca remove colunas.
- Loading incumbente: página = pulse "Carregando…" (`app/app/pipelines/[id]/_client.tsx:142-145`),
  board = `BoardSkeleton` (`KanbanBoard.tsx:64,243`). Testes casam o incumbente; sem redesign.
- Botão "Limpar filtros" só renderiza quando `onLimparFiltros` é fornecido — sem botão morto.

## Estados (matriz de aceite)

| Estado | Inbox | Kanban |
|---|---|---|
| Carregando | skeletons (existe) | pulse "Carregando…" na página + `BoardSkeleton` no board (existe) |
| Erro | msg + retry (existe) | msg + detalhe (existe) |
| Sem etapas | n/a | "Nenhuma etapa configurada." (NOVO, substitui rótulo errado) |
| Vazio por ausência | `EmptyInbox` (existe) | notice acima das colunas: "Nenhum lead nesta pipeline ainda." (NOVO) |
| Vazio por filtro | `EmptyPorFiltro` (existe) | notice acima das colunas: "Nenhum lead com esses filtros" + filtros ativos + "Limpar filtros" (NOVO) |
| Não selecionado | "Selecione uma conversa" (existe) | n/a |

## Arquivos (dono único por arquivo)

1. `lib/kanban/filtros-ativos.ts` (novo) — deriva rótulos dos filtros ativos de `LeadFilters`.
   Campos REAIS verificados em `lib/kanban/filters.ts:25-48`: `owner`, `status`, `tag`,
   `tagMode`, `search`, `valueCentsMin`, `valueCentsMax`, `overdueOnly`, `lostReason`,
   `lostCategory`. **`unreadOnly`/`channel`/datas NÃO existem em `LeadFilters`** — o helper
   não os inventa.
2. `components/kanban/EmptyPorFiltro.tsx` (novo) — espelha o do inbox; `Funnel` de `@/lib/ui/icons`,
   `useT()`, botão "Limpar filtros" só com `onLimpar`.
3. `components/kanban/KanbanBoard.tsx` — recebe `filtrosAtivos: string[]` e
   `onLimparFiltros?: () => void`; notice acima das colunas nos dois vazios; `stages.length === 0`
   → "Nenhuma etapa configurada."; colunas/drop targets preservados sempre.
4. `app/app/pipelines/[id]/_client.tsx` — calcula `filtrosAtivos` via o novo helper (useMemo) e
   passa `onLimparFiltros = () => setFilters({ status: "all" })`.
5. `lib/i18n/dicionario.ts` — entradas `es` para toda string nova. **`en` não existe no
   dicionário** (verificado: só `es`); o gate é `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`.
6. Testes: `lib/kanban/filtros-ativos.test.ts`, `components/kanban/EmptyPorFiltro.test.tsx`,
   `components/kanban/KanbanBoard.test.tsx` (estados: loading incumbente/erro/vazio/filtrado/
   sem-etapas/colunas preservadas).

## Regras de produto

- Tokens canônicos (Sage/Atkinson/Plex Mono/Phosphor/Aerada); sem CSS global novo; sem estado
  vazio ilustrativo; copy funcional (voz: claro, conciso, confiante, calmo — `docs/design-system/08-voice-and-tone.md`).
- Acent runtime white-label preservado; `t()` em toda string visível; `es` no dicionário.
- Foco visível 2px; alvos ≥44px; `prefers-reduced-motion`; papéis: CTA de criar só com
  `podeGerenciar` (`ROLE_RANK`); mobile: notice empilha acima das colunas, "Limpar filtros" alcançável.
- Living System: toda demanda (lead/conversa) continua com próximo passo visível; o vazio
  filtrado nomeia os filtros e oferece saída — nenhum laço fica sem resposta.

## Verificação e evidência

- Gates: `pnpm vitest run` nos arquivos de teste novos, `pnpm typecheck`, `pnpm lint`,
  `pnpm test:unit` (inclui guardião i18n).
- **E2E é obrigatório para UI e está BLOQUEADO**: ambiente sem Docker/bash e sem `.env.e2e` —
  declarar bloqueado, nunca N/A nem "completo". Prova interina possível: harness visual de
  componente no browser, que NÃO equivale a VPS fresca.
- Evidência em `docs/evidence/operational-ux-refinement/`, dados sintéticos apenas.

## Fora de escopo

Finanças/MRR/projetos/auth/schema; redesign de navegação; novos providers; SDK/marketplace.
