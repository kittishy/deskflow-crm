import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Lead } from "@/lib/types/leads";
import type { Pipeline, Stage } from "@/lib/kanban/types";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

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
vi.mock("./StageColumn", () => ({
  StageColumn: ({ stage }: { stage: Stage }) => <div data-testid="coluna">{stage.name}</div>,
}));

import { KanbanBoard } from "./KanbanBoard";

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

const leads: Lead[] = [];

const boardOk = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  pulses: new Map(),
};

describe("KanbanBoard — estados operacionais honestos", () => {
  it("sem etapas: rótulo honesto, sem colunas", () => {
    useBoardMock.mockReturnValue(boardOk);
    render(<KanbanBoard pipelineId="p1" stages={[]} leads={leads} pipeline={pipeline} />);
    expect(screen.getByText("Nenhuma etapa configurada.")).toBeInTheDocument();
    expect(screen.queryByTestId("coluna")).toBeNull();
  });

  it("zero leads sem filtro: notice de ausência ACIMA das colunas, colunas preservadas", () => {
    useBoardMock.mockReturnValue(boardOk);
    render(
      <KanbanBoard
        pipelineId="p1"
        stages={[stage("s1", "Novo"), stage("s2", "Ganho")]}
        leads={leads}
        pipeline={pipeline}
      />,
    );
    expect(screen.getByText("Nenhum lead nesta pipeline ainda.")).toBeInTheDocument();
    expect(screen.getAllByTestId("coluna")).toHaveLength(2);
  });

  it("zero leads com filtro: notice nomeia filtros e oferece limpar, colunas preservadas", () => {
    useBoardMock.mockReturnValue(boardOk);
    render(
      <KanbanBoard
        pipelineId="p1"
        stages={[stage("s1", "Novo"), stage("s2", "Ganho")]}
        leads={leads}
        pipeline={pipeline}
        filtrosAtivos={["Busca"]}
        onLimparFiltros={() => {}}
      />,
    );
    expect(screen.getByText("Nenhum lead com esses filtros")).toBeInTheDocument();
    expect(screen.getByText(/Ativos:/)).toHaveTextContent("Ativos: Busca");
    expect(screen.getByRole("button", { name: "Limpar filtros" })).toBeInTheDocument();
    expect(screen.getAllByTestId("coluna")).toHaveLength(2);
  });

  it("loading: BoardSkeleton incumbente", () => {
    useBoardMock.mockReturnValue({ ...boardOk, isLoading: true });
    const { container } = render(<KanbanBoard pipelineId="p1" />);
    expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThan(0);
    expect(screen.queryByTestId("coluna")).toBeNull();
  });

  it("erro: mensagem incumbente", () => {
    useBoardMock.mockReturnValue({
      ...boardOk,
      isError: true,
      error: new Error("falhou"),
    });
    render(<KanbanBoard pipelineId="p1" />);
    expect(screen.getByText(/Falha ao carregar o board\./)).toBeInTheDocument();
  });
});
