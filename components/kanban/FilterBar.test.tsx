import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilterBar } from "./FilterBar";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useUser: () => ({ id: "user-test" }) }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({
  useAssignableAgents: () => ({ data: [] }),
}));

afterEach(() => vi.useRealTimers());

describe("FilterBar — busca reflete o filtro aplicado", () => {
  it("limpar fora da barra também limpa o texto visível", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { rerender } = render(
      <FilterBar filters={{ search: "padaria" }} leads={[]} onChange={onChange} />,
    );
    expect(screen.getByRole("searchbox")).toHaveValue("padaria");
    rerender(<FilterBar filters={{ status: "all" }} leads={[]} onChange={onChange} />);
    expect(screen.getByRole("searchbox")).toHaveValue("");
    act(() => vi.advanceTimersByTime(300));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("navegar para outra busca atualiza o campo sem restaurar o filtro anterior", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { rerender } = render(
      <FilterBar filters={{ search: "padaria" }} leads={[]} onChange={onChange} />,
    );
    rerender(<FilterBar filters={{ search: "clínica" }} leads={[]} onChange={onChange} />);
    expect(screen.getByRole("searchbox")).toHaveValue("clínica");
    act(() => vi.advanceTimersByTime(300));
    expect(onChange).not.toHaveBeenCalled();
  });
});
