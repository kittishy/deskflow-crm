import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FilaDeEnvioPanel } from "./FilaDeEnvioPanel";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const useFilaDeEnvio = vi.fn();
const acoes = {
  editar: vi.fn(async () => undefined),
  pausar: vi.fn(async () => undefined),
  retomar: vi.fn(async () => undefined),
  enviarAgora: vi.fn(async () => undefined),
  cancelar: vi.fn(async () => undefined),
};
vi.mock("@/hooks/inbox/useFilaDeEnvio", () => ({
  useFilaDeEnvio: (...args: unknown[]) => useFilaDeEnvio(...args),
  useFilaDeEnvioAcoes: () => acoes,
}));

const item = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  organization_id: "org1",
  message_id: "m1",
  contact_id: "c1",
  conversation_id: "conv1",
  channel_session_id: "s1",
  tipo: "resposta",
  status: "pending",
  prioridade: 0,
  scheduled_at: new Date(Date.now() + 90_000).toISOString(),
  tentativas: 0,
  max_tentativas: 3,
  enviado_em: null,
  pausado_em: null,
  pausado_motivo: null,
  cancelado_em: null,
  falho_em: null,
  erro: null,
  editada_em: null,
  criado_em: new Date().toISOString(),
  mensagem: { body: "Olá, tudo bem?" },
  contato: { nome: "Maria" },
  ...over,
});

beforeEach(() => {
  useFilaDeEnvio.mockReset();
  Object.values(acoes).forEach((fn) => fn.mockClear());
});

describe("FilaDeEnvioPanel", () => {
  it("mostra a contagem e abre o painel ordenado com prévia do corpo e contato", async () => {
    useFilaDeEnvio.mockImplementation((opts?: { somenteAguardando?: boolean }) =>
      opts?.somenteAguardando
        ? { data: { aguardando: 2 }, isLoading: false, isError: false }
        : { data: [item(), item({ id: "f2", contato: { nome: "João" }, mensagem: { body: "Segunda mensagem" } })], isLoading: false, isError: false },
    );
    render(<FilaDeEnvioPanel />);
    const botao = screen.getByRole("button", { name: /Fila de envio: 2 mensagens/ });
    fireEvent.click(botao);
    expect(await screen.findByText("Olá, tudo bem?")).toBeInTheDocument();
    expect(screen.getByText("Maria")).toBeInTheDocument();
    expect(screen.getByText("Segunda mensagem")).toBeInTheDocument();
    expect(screen.getByText("João")).toBeInTheDocument();
  });

  it("estado vazio diz que não há mensagens", async () => {
    useFilaDeEnvio.mockImplementation((opts?: { somenteAguardando?: boolean }) =>
      opts?.somenteAguardando
        ? { data: { aguardando: 0 }, isLoading: false, isError: false }
        : { data: [], isLoading: false, isError: false },
    );
    render(<FilaDeEnvioPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Fila de envio: 0 mensagens/ }));
    expect(await screen.findByText("Nenhuma mensagem na fila.")).toBeInTheDocument();
  });

  it("erro de leitura aparece no painel", async () => {
    useFilaDeEnvio.mockImplementation((opts?: { somenteAguardando?: boolean }) =>
      opts?.somenteAguardando
        ? { data: undefined, isLoading: false, isError: true }
        : { data: undefined, isLoading: false, isError: true },
    );
    render(<FilaDeEnvioPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Fila de envio/ }));
    expect(await screen.findByText("Não foi possível carregar a fila de envio.")).toBeInTheDocument();
  });

  it("carregando mostra o estado de espera", async () => {
    useFilaDeEnvio.mockImplementation((opts?: { somenteAguardando?: boolean }) =>
      opts?.somenteAguardando
        ? { data: undefined, isLoading: true, isError: false }
        : { data: undefined, isLoading: true, isError: false },
    );
    render(<FilaDeEnvioPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Fila de envio/ }));
    expect(await screen.findByText("Carregando…")).toBeInTheDocument();
  });

  it("ações do item chamam o hook de ações", async () => {
    useFilaDeEnvio.mockImplementation((opts?: { somenteAguardando?: boolean }) =>
      opts?.somenteAguardando
        ? { data: { aguardando: 1 }, isLoading: false, isError: false }
        : { data: [item()], isLoading: false, isError: false },
    );
    render(<FilaDeEnvioPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Fila de envio: 1 mensagem/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Enviar agora" }));
    await waitFor(() => expect(acoes.enviarAgora).toHaveBeenCalledWith("f1"));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(acoes.cancelar).toHaveBeenCalledWith("f1"));
  });
});
