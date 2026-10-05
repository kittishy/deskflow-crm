import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EmptyPorFiltro } from "./EmptyPorFiltro";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

describe("EmptyPorFiltro (kanban)", () => {
  it("diz que nenhum lead casa com os filtros e lista os ativos", () => {
    render(<EmptyPorFiltro filtros={["Busca", "Etiqueta"]} />);
    expect(screen.getByText("Nenhum lead com esses filtros")).toBeInTheDocument();
    expect(screen.getByText(/Ativos:/)).toHaveTextContent("Ativos: Busca · Etiqueta");
  });

  it("com onLimpar, o botão chama onLimpar", async () => {
    const onLimpar = vi.fn();
    render(<EmptyPorFiltro filtros={["Busca"]} onLimpar={onLimpar} />);
    await userEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(onLimpar).toHaveBeenCalledTimes(1);
  });

  it("sem onLimpar não renderiza botão morto", () => {
    render(<EmptyPorFiltro filtros={["Busca"]} />);
    expect(screen.queryByRole("button", { name: "Limpar filtros" })).toBeNull();
  });

  it("anuncia o resultado filtrado sem incluir o botão na região de status", () => {
    render(<EmptyPorFiltro filtros={["Busca"]} onLimpar={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Nenhum lead com esses filtros");
    expect(status).toHaveTextContent("Ativos: Busca");
    expect(status).not.toContainElement(screen.getByRole("button", { name: "Limpar filtros" }));
  });

  it("associa a ação ao aviso mesmo quando a barra também oferece limpar", async () => {
    const onLimpar = vi.fn();
    render(
      <>
        <button>Limpar filtros</button>
        <EmptyPorFiltro filtros={["Busca"]} onLimpar={onLimpar} />
      </>,
    );
    const aviso = screen.getByRole("group", { name: "Nenhum lead com esses filtros" });
    await userEvent.click(within(aviso).getByRole("button", { name: "Limpar filtros" }));
    expect(onLimpar).toHaveBeenCalledTimes(1);
  });
});
