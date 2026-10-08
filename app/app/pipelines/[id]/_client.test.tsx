import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Pipeline, Stage } from "@/lib/kanban/types";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/app/pipelines/p1",
  useSearchParams: () => new URLSearchParams("q=padaria"),
}));

const useBoardMock = vi.fn();
vi.mock("@/hooks/kanban/useBoard", () => ({
  useBoard: (...args: unknown[]) => useBoardMock(...args),
}));
vi.mock("@/hooks/kanban/useMoveCard", () => ({
  useMoveCard: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/kanban/useRenameStage", () => ({
  useRenameStage: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/leads/useAtRiskLeads", () => ({
  useAtRiskLeads: () => ({ data: { items: [] } }),
}));
vi.mock("@/hooks/leads/useReactivations", () => ({
  useReactivations: () => ({ data: [] }),
}));
vi.mock("@/components/kanban/FilterBar", () => ({
  FilterBar: () => <div data-testid="filterbar" />,
}));
vi.mock("@/components/kanban/BulkActionBar", () => ({
  BulkActionBar: () => null,
}));
vi.mock("@/components/kanban/NewLeadDialog", () => ({
  NewLeadDialog: () => null,
}));
vi.mock("@/components/kanban/StageColumn", () => ({
  StageColumn: ({ stage }: { stage: Stage }) => <div data-testid="coluna">{stage.name}</div>,
}));

import { PipelinePageClient } from "./_client";

const pipeline: Pipeline = {
  id: "p1",
  organization_id: "org1",
  name: "Funil",
  slug: "funil",
  description: null,
  is_default: true,
  is_archived: false,
  position: 0,
  vocabulary: {},
  settings: {},
};

const stage = (id: string, name: string): Stage => ({
  id,
  organization_id: "org1",
  pipeline_id: "p1",
  name,
  slug: id,
  position: 0,
  color: null,
  is_won: false,
  is_lost: false,
  is_archived: false,
  expected_duration_hours: null,
});

describe("PipelinePageClient — filtros ativos no quadro", () => {
  it("com busca na URL e zero leads, o quadro nomeia o filtro e limpar zera a query string", async () => {
    useBoardMock.mockReturnValue({
      data: { pipeline, stages: [stage("s1", "Novo")], leads: [] },
      isLoading: false,
      error: null,
      pulses: new Map(),
      realtimeStatus: "subscribed",
      seguranca: { divergencias: 0, ultimaVerificacao: null },
    });
    render(<PipelinePageClient pipelineId="p1" initialName="Funil" role="manager" />);

    expect(screen.getByText("Nenhum lead com esses filtros")).toBeInTheDocument();
    expect(screen.getByText(/Ativos:/)).toHaveTextContent("Ativos: Busca");

    await userEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(replaceMock).toHaveBeenCalledWith("/app/pipelines/p1", { scroll: false });
  });
});
