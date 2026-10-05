/**
 * A ROTA que serve o painel a quem não tem sessão.
 *
 * Quatro propriedades, e três delas são sobre recusa — porque numa rota pública
 * a falha de segurança é a que responde 200:
 *
 * 1. **A organização vem da LINHA.** Service role bypassa RLS, então o único
 *    filtro que separa a conta de quem tem o link da conta de quem não tem é o
 *    `organization_id` lido de `public_panels` (`lib/painel-publico/resolver.ts`).
 *    O id da URL é o do PAINEL; `organization_id` da query é de outra coisa.
 * 2. **Painel desligado, inexistente e banco fora do ar devolvem o MESMO 404.**
 *    Respostas diferentes transformariam a rota em enumerador de UUIDs válidos
 *    da instalação.
 * 3. **Sem IP não conta.** Um balde global aqui trancaria o painel inteiro da
 *    instalação para todo mundo — a mesma razão de `clientIp` em
 *    `lib/plataformas-de-anuncio/pagina-de-captura.ts`.
 * 4. **`no-store`.** Métrica ao vivo com cache em CDN vira número velho com
 *    aparência de atual, e um painel revogado (`enabled = false`) continuaria
 *    sendo servido do cache depois de desligado.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerMetricasPublicas, resolverPainelPublico } from "@/lib/painel-publico/resolver";
import type * as Resolver from "@/lib/painel-publico/resolver";

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const PAINEL = "33333333-3333-4333-8333-333333333333";

vi.mock("@/lib/painel-publico/resolver", async () => {
  const real = await vi.importActual<typeof Resolver>("@/lib/painel-publico/resolver");
  return {
    ...real,
    resolverPainelPublico: vi.fn(async () => null),
    lerMetricasPublicas: vi.fn(async () => ({
      janela: { de: "2026-09-02T12:00:00.000Z", ate: "2026-10-02T12:00:00.000Z", dias: 30 },
      resumo: {
        negocios_ganhos: 8,
        negocios_perdidos: 2,
        negocios_encerrados: 10,
        conversas: 40,
        taxa_de_conversao: 0.8,
      },
      perda: { total: 10, por_categoria: [], categorias_truncadas: false },
      medidas: [],
    })),
  };
});

const METRICAS = {
  janela: { de: "2026-09-02T12:00:00.000Z", ate: "2026-10-02T12:00:00.000Z", dias: 30 },
  resumo: {
    negocios_ganhos: 8,
    negocios_perdidos: 2,
    negocios_encerrados: 10,
    conversas: 40,
    taxa_de_conversao: 0.8,
  },
  perda: {
    total: 10,
    por_categoria: [{ chave: "Preço", quantidade: 6 }],
    categorias_truncadas: false,
  },
  medidas: [],
};

function pedido(id = PAINEL, ip = "203.0.113.7"): NextRequest {
  const req = new NextRequest(`https://crm.exemplo/api/v1/painel-publico/${id}`);
  if (ip !== "") req.headers.set("x-forwarded-for", `${ip}, 10.0.0.1`);
  return req;
}

async function chamar(id = PAINEL, ip = "203.0.113.7") {
  const { GET } = await import("@/app/api/v1/painel-publico/[id]/route");
  return GET(pedido(id, ip), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(createAdminClient).mockReturnValue({} as never);
  vi.mocked(resolverPainelPublico).mockResolvedValue({
    id: PAINEL,
    organizationId: "22222222-2222-4222-8222-222222222222",
    title: "Painel da Clínica Aurora",
    windowDays: 30,
  });
  vi.mocked(lerMetricasPublicas).mockResolvedValue(METRICAS);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/painel-publico/[id]", () => {
  it("devolve as métricas agregadas da organização dona do painel", async () => {
    const res = await chamar();
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(corpo.data).toMatchObject({
      painel: { title: "Painel da Clínica Aurora" },
      resumo: { negocios_ganhos: 8, conversas: 40 },
    });
    // A organização dona é do PAINEL; o id da URL é só o do painel.
    expect(vi.mocked(lerMetricasPublicas).mock.calls[0]?.[1]).toMatchObject({
      organizationId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("NENHUM org_id da query chega ao painel — o id da URL é só o do painel", async () => {
    await chamar(PAINEL);
    const [admin, painel] = vi.mocked(lerMetricasPublicas).mock.calls[0] ?? [];
    expect(admin).toBeDefined();
    expect(JSON.stringify(painel)).not.toContain("organization_id");
  });

  it("id fora de forma de UUID dá o MESMO 404 do painel inexistente", async () => {
    const res = await chamar("nao-e-uuid");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not_found");
    expect(resolverPainelPublico).not.toHaveBeenCalled();
  });

  it("painel desligado ou inexistente é 404 — e o corpo não diz qual dos dois", async () => {
    vi.mocked(resolverPainelPublico).mockResolvedValue(null);
    const res = await chamar();
    expect(res.status).toBe(404);
    expect(lerMetricasPublicas).not.toHaveBeenCalled();
  });

  it("rate limit por IP no painel: estoura e devolve 429 com Retry-After", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const res = await chamar();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(resolverPainelPublico).not.toHaveBeenCalled();
  });

  it("o balde é por PAINEL e por IP — um painel não tranca outro", async () => {
    await chamar(PAINEL, "198.51.100.9");
    expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toContain(PAINEL);
    expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toContain("198.51.100.9");
  });

  it("sem IP identificável a rota NÃO limita — o balde global trancaria a instalação", async () => {
    const res = await chamar(PAINEL, "");
    expect(res.status).toBe(200);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("métrica ao vivo não vai para cache de CDN", async () => {
    const res = await chamar();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });
});
