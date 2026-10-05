# Operational UX component evidence

These captures contain synthetic data only. They prove component rendering, not
authenticated CRM behavior, database persistence, RLS, or a fresh VPS installation.

## Method

Temporary Vite harness at `127.0.0.1:4317`, outside the repository, importing the
actual `EmptyPorFiltro`, `FilterBar`, `IdiomaProvider`, filter helper and
`app/globals.css`. Authentication/member hooks are synthetic fixtures. The harness
uses a system sans-serif fallback, not the application's complete font/layout setup.

## Captures and measurements

- `component-before-desktop.png`: initial notice, 1440px viewport, 180px tall.
- `component-after-desktop.png`: compact notice, same viewport, 56px tall.
- `component-after-mobile-es-dark.png`: 390px, Spanish/dark, 44px touch action.
- `components-integrated-desktop.png`: real filter bar and notice, 1440px.
- `components-integrated-mobile-es-dark.png`: same components, 390px, Spanish/dark.

Measured no page-level horizontal overflow in either viewport. In Spanish/dark,
notice text contrast was 17.33:1 and secondary text 8.04:1 against the actual body
background. An earlier keyboard pass measured the canonical visible focus ring;
both integrated passes activated the notice's clear button using Enter, emptied
the real search field, and removed the filtered-result notice. Without a clear
callback, the notice rendered no dead action. Final component-page console check
reported zero errors; initial harness resolution errors were corrected separately.

## Remaining gates

Full E2E is blocked by missing local Supabase/`.env.e2e`. The regression cases in
`tests/e2e/kanban-owner-filter.spec.ts` are not claimed as executed. The complete
unit suite is not green. See
`docs/evidence/operational-ux-refinement/tdd.md` for exact commands and failures.

## Living System checklist

- Input: the same `LeadFilters` consumed by `applyFilters` on the pipeline page.
- Output: `KanbanBoard` notice naming the applied filters; existing stages remain.
- Visible recovery: clear returns to the unfiltered URL and reconciles `FilterBar`.
- Entry: existing `/app/pipelines/[id]`; no new navigation destination.
- Audit/events: unchanged; clearing display filters is not a data mutation.
- Configuration: existing URL/filter bar; no new settings.
- AI/human handoff: unchanged; not involved in this presentation-only slice.
- Failure feedback: status text and the existing loading/error paths remain.
- Architecture: existing pipeline view and query flow retained; no new service,
  table, consumer, or automated decision was introduced.
