import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RitmoDeEnvioForm } from "./_form";
import { RITMO_PADRAO } from "@/lib/messaging/fila/config";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const salvar = vi.fn();
vi.mock("@/app/actions/settings/ritmoDeEnvio", () => ({
  salvarRitmoDeEnvio: (...args: unknown[]) => salvar(...args),
}));

beforeEach(() => {
  salvar.mockReset();
  salvar.mockResolvedValue({ ok: true });
});

describe("RitmoDeEnvioForm", () => {
  it("mostra as seis configurações com os valores gravados", () => {
    render(<RitmoDeEnvioForm initial={RITMO_PADRAO} />);
    expect(screen.getByLabelText("Ligar ritmo de envio")).not.toBeChecked();
    expect(screen.getByLabelText("Intervalo mínimo (segundos)")).toHaveValue(90);
    expect(screen.getByLabelText("Intervalo máximo (segundos)")).toHaveValue(180);
    expect(screen.getByLabelText("Priorizar conversas ativas")).toBeChecked();
    expect(screen.getByLabelText("Pausar se o contato respondeu")).toBeChecked();
    expect(screen.getByLabelText("Limite diário de novas abordagens")).toHaveValue(20);
  });

  it("salvar envia os seis campos para a action", async () => {
    render(<RitmoDeEnvioForm initial={RITMO_PADRAO} />);
    fireEvent.click(screen.getByLabelText("Ligar ritmo de envio"));
    fireEvent.change(screen.getByLabelText("Intervalo mínimo (segundos)"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("Intervalo máximo (segundos)"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Limite diário de novas abordagens"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(salvar).toHaveBeenCalledWith({
        ativo: true,
        intervalo_minimo_s: 60,
        intervalo_maximo_s: 120,
        priorizar_conversas_ativas: true,
        pausar_se_contato_respondeu: true,
        limite_diario_prospeccoes: 10,
      }),
    );
  });

  it("erro da action aparece como toast de erro", async () => {
    const { toast } = await import("sonner");
    salvar.mockResolvedValue({ ok: false, error: "forbidden_role" });
    render(<RitmoDeEnvioForm initial={RITMO_PADRAO} />);
    fireEvent.click(screen.getByLabelText("Ligar ritmo de envio"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("intervalo máximo menor que o mínimo é recusado antes de salvar", async () => {
    render(<RitmoDeEnvioForm initial={RITMO_PADRAO} />);
    fireEvent.change(screen.getByLabelText("Intervalo mínimo (segundos)"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText("Intervalo máximo (segundos)"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(salvar).not.toHaveBeenCalled());
  });
});
