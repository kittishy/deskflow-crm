import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@/lib/api/types";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: mocks.post } }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (message: string) => message }));
vi.mock("./RunTrace", () => ({ RunTrace: () => null }));

import { TestPanel } from "./TestPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TestPanel error visibility", () => {
  it("keeps the failed test reason visible after the toast disappears", async () => {
    mocks.post.mockRejectedValueOnce(
      new ApiError(503, "agent_test_failed", undefined, "request-1", "O provedor não respondeu."),
    );
    render(
      <TestPanel
        agent={{ id: "agent-1" } as AgentRow}
        draft={{ id: "version-1", status: "draft", version_number: 2, provider: "openrouter", model: "free" } as unknown as AgentVersionRow}
        published={null}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Mensagem do cliente/), { target: { value: "Quanto custa?" } });
    fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("O provedor não respondeu.");
    expect(screen.queryByText("Nenhum teste executado ainda.")).toBeNull();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("O provedor não respondeu."));
  });
});
