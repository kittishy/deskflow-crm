import { afterEach, describe, expect, it, vi } from "vitest";
import { montarEstadoDaChave } from "./estado";

describe("estado da chave no modo free-only", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("declara a busca textual sem consultar credenciais de embedding", async () => {
    vi.stubEnv("AI_FREE_ONLY_ORGANIZATION_IDS", "org-text-only");
    const from = vi.fn();
    const estado = await montarEstadoDaChave({ from } as never, "org-text-only");
    expect(estado).toMatchObject({ somente_textual: true, pode_indexar: true, chave_em_uso: null });
    expect(estado.explicacao).toContain("busca textual");
    expect(from).not.toHaveBeenCalled();
  });
});
