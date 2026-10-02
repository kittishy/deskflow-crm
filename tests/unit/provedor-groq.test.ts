/**
 * A GROQ É PROVEDOR DE PRIMEIRA CLASSE — as duas pontas da corrente.
 *
 * Mesmo molde de `tests/unit/provedor-deepseek.test.ts`: a migration 0127
 * abriu `provider` no banco e transferiu a garantia para
 * `lib/ai/pontos/provedores.ts`. Este arquivo prende o caso concreto da Groq —
 * provedor das verificações auxiliares do agente de mineração de leads — para
 * que a próxima sessão não precise redescobrir que "entrar na lista" é só a
 * metade.
 *
 * Os dois caminhos que a Groq atravessa e que este arquivo trava:
 *
 *  - ESCRITA: `versionCreateSchema` (e todas as portas que derivam de
 *    `IDS_DE_PROVEDOR` — rota de credenciais, diálogo, hook da tela) aceita
 *    `provider=groq`.
 *  - EXECUÇÃO: o registry de produção e o runtime de ensaio sabem instanciar
 *    groq como OpenAI-compatível (base URL própria, `.chat()`, sem SDK novo).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { versionCreateSchema } from "@/lib/ai/agents/validation";
import { ehProvedorSuportado, IDS_DE_PROVEDOR, PROVEDOR_POR_ID } from "@/lib/ai/pontos/provedores";
import { validateProviderKey } from "@/lib/ai/provider-validators";
import { buildModel } from "@/lib/ai/runtime/agent";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Groq é aceita na ESCRITA", () => {
  it("está na lista única de que derivam todas as portas de escrita", () => {
    expect(IDS_DE_PROVEDOR).toContain("groq");
    expect(ehProvedorSuportado("groq")).toBe(true);
  });

  it("o schema de versão de agente aceita provider=groq", () => {
    const r = versionCreateSchema.safeParse({
      system_prompt: "Você é um atendente útil e cordial.",
      provider: "groq",
      model: "qwen/qwen3.8-27b",
      credential_id: null,
      channel_session_id: null,
    });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });
});

describe("Groq é executável", () => {
  it("declara os campos que a tela precisa", () => {
    const p = PROVEDOR_POR_ID.get("groq");
    expect(p).toBeDefined();
    expect(p!.rotulo.trim().length).toBeGreaterThan(0);
    expect(p!.quandoUsar.trim().length).toBeGreaterThan(20);
    expect(p!.aceitaEndpointProprio).toBe(true);
    expect(p!.catalogoSincronizavel).toBe(false);
    expect(p!.ondePegarAChave).toMatch(/^https:\/\//);
    expect(p!.prefixoDaChave).toBe("gsk_…");
  });

  it("o registry de PRODUÇÃO tem a fábrica", () => {
    expect(createDefaultRegistry()["groq"]).toBeTypeOf("function");
  });

  it("a fábrica honra um endpoint próprio (é OpenAI-compatível)", () => {
    const modelo = createDefaultRegistry()["groq"]!(
      "sk-de-teste",
      "qwen/qwen3.8-27b",
      "https://gateway.exemplo/v1",
    );
    expect(modelo).toBeDefined();
  });

  it("o runtime de ENSAIO executa groq (buildModel)", () => {
    expect(() => buildModel("groq", "sk-de-teste", "qwen/qwen3.8-27b")).not.toThrow();
  });

  it("o validador de chave conhece groq (não cai em unknown_provider)", async () => {
    // A prova tem de ser um endpoint AUTENTICADO — 401 é a resposta honesta de
    // chave ruim, e é o que separa "conheço o provedor" de "cai no default".
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 401,
            json: async () => ({}),
          }) as unknown as Response,
      ),
    );
    const r = await validateProviderKey("groq", "");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.startsWith("unknown_provider")).toBe(false);
    expect(r.ok === false && r.error).toBe("auth_failed_401");
  });
});
