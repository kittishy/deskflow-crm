import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: mocks.post } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (message: string) => message }));

import { AcervoSearch } from "@/components/inbox/AcervoSearch";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AcervoSearch textual ranking", () => {
  it("labels lexical matches and does not display rank as vector similarity", async () => {
    mocks.post.mockResolvedValueOnce({
      data: {
        trechos: [{ chunk_id: "chunk-1", source_name: "Preços", content: "Criação de site: R$ 479.", similarity: 0.23 }],
        melhorSimilaridade: 0.23,
        motivo: null,
        acervo: { fontes: 1, limiar: 0.4 },
        modo: "textual",
      },
    });
    render(<AcervoSearch />);
    fireEvent.change(screen.getByTestId("acervo-pergunta"), { target: { value: "qual o preço de criar um site?" } });
    fireEvent.click(screen.getByTestId("acervo-buscar"));

    expect(await screen.findByText("Correspondência textual")).toBeInTheDocument();
    expect(screen.getByTestId("acervo-resumo")).toHaveTextContent("Busca textual em português");
    expect(screen.queryByText("23%")).toBeNull();
  });
});
