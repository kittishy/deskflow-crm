/**
 * A TELA DO PAINEL PÚBLICO — o que alguém sem sessão enxerga.
 *
 * Esta tela é a prova de que a orgResolveda chegou até o fim: se a marca saísse
 * do banco em vez de `marcaDaSaida`, quem lê veria o nome de outra instalação; se
 * o `title` fosseeco, a tela ensinaria o nome do produto a quem recebeu o link.
 * Por isso os três casos de marca estão aqui — e o caso ⭐ é o do vazio: painel
 * desligado não pode responder com o 404 do produto nem com a tela de erro que
 * cita o produto, porque quem está do outro lado não é usuário dele.
 *
 * Os testes medem TEXTO RENDERIZADO, não props: o que está no HTML servido é o
 * que chega em quem não tem sessão.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { marcaDaSaida } from "@/lib/branding/saida";
import { lerMetricasPublicas, resolverPainelPublico } from "@/lib/painel-publico/resolver";
import type * as Resolver from "@/lib/painel-publico/resolver";
import type { MetricasPublicas } from "@/lib/painel-publico/metricas";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
// A tela resolve o idioma do visitante por `Accept-Language` (tela pública, sem
// sessão). O header é mockado para o padrão do produto, que é o que o resto dos
// casos abaixo assumem ao ler o texto renderizado.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "accept-language": "pt-BR,pt;q=0.9" }),
}));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: vi.fn(async () => ({
    nome: "Clínica Aurora",
    logoUrl: null,
    accent: "#2f6f4f",
    accentFg: "#ffffff",
    origens: { nome: "organizacao", cor: "organizacao" },
  })),
}));
vi.mock("@/lib/painel-publico/resolver", async () => {
  const real = await vi.importActual<typeof Resolver>("@/lib/painel-publico/resolver");
  return {
    ...real,
    resolverPainelPublico: vi.fn(),
    lerMetricasPublicas: vi.fn(),
  };
});

const PAINEL = "33333333-3333-4333-8333-333333333333";
const ORG_DONA = "22222222-2222-4222-8222-222222222222";

// A tipagem vem do contrato de produção: um dublê que "casa" por acidente deixa
// de provar o payload, porque passa a aceitar uma medida com `unidade: "string"`.
const METRICAS: MetricasPublicas = {
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
    por_categoria: [
      { chave: "Preço", quantidade: 6 },
      { chave: "Timing", quantidade: 4 },
    ],
    categorias_truncadas: false,
  },
  medidas: [
    {
      chave: "conversao",
      titulo: "Conversão",
      eficiencia: { chave: "ganhos", rotulo: "Negócios ganhos", valor: 8, unidade: "contagem" },
      danos: [
        {
          chave: "turnos_p50",
          rotulo: "Turnos até o desfecho (mediana)",
          valor: 7,
          unidade: "media",
          nota: "Sobre as demandas encerradas no período.",
        },
      ],
    },
  ],
};

async function tela(id = PAINEL) {
  const { default: Page } = await import("@/app/painel-publico/[id]/page");
  return Page({ params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.mocked(resolverPainelPublico).mockResolvedValue({
    id: PAINEL,
    organizationId: ORG_DONA,
    title: "Painel da Clínica Aurora",
    windowDays: 30,
  });
  vi.mocked(lerMetricasPublicas).mockResolvedValue(METRICAS);
  vi.mocked(marcaDaSaida).mockResolvedValue({
    nome: "Clínica Aurora",
    logoUrl: null,
    accent: "#2f6f4f",
    accentFg: "#ffffff",
    origens: { nome: "organizacao", cor: "organizacao" },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("/painel-publico/[id]", () => {
  it("renderiza o número agregado sem nenhuma sessão", async () => {
    render(await tela());

    expect(screen.getByRole("heading", { name: "Painel da Clínica Aurora" })).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(screen.getByText("80.0%")).toBeInTheDocument();
    // O org do painel é o dono da conta — e a tela não diz o id dele.
    expect(marcaDaSaida).toHaveBeenCalledWith(ORG_DONA);
    expect(document.body.textContent).not.toContain(ORG_DONA);
  });

  it("escreve o PERÍODO com o número — índice sem janela é número sem contexto", async () => {
    render(await tela());
    expect(screen.getByText(/30 dias/)).toBeInTheDocument();
  });

  it("cada número vem com a ressalva que o acompanha", async () => {
    render(await tela());
    expect(screen.getByText("Turnos até o desfecho (mediana)")).toBeInTheDocument();
    expect(screen.getByText("Sobre as demandas encerradas no período.")).toBeInTheDocument();
  });

  it("as categorias de perda aparecem por cima do total", async () => {
    render(await tela());
    expect(screen.getByText("Preço")).toBeInTheDocument();
    expect(screen.getByText("Timing")).toBeInTheDocument();
  });

  it("SEM MEDIÇÃO DE ATRITO a tela diz que não mediu — e não escreve 0%", async () => {
    vi.mocked(lerMetricasPublicas).mockResolvedValue({ ...METRICAS, medidas: [] });
    render(await tela());

    expect(screen.getByText(/ainda não tem medições de atendimento/i)).toBeInTheDocument();
    // A ÚNICA porcentagem da tela é a conversão. Uma medida de atrito com 0%
    // apareceria aqui como "0.0%" e passaria como "não houve atrito".
    expect(document.body.textContent?.match(/[\d.,]+%/g)).toEqual(["80.0%"]);
  });

  it("⭐ PAINEL INDISPONÍVEL não vaza marca nem o id pedido", async () => {
    vi.mocked(resolverPainelPublico).mockResolvedValue(null);
    render(await tela());

    expect(screen.getByText(/indisponível/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(ORG_DONA);
    expect(document.body.textContent).not.toContain(PAINEL);
    expect(marcaDaSaida).not.toHaveBeenCalled();
    expect(lerMetricasPublicas).not.toHaveBeenCalled();
  });

  it("id fora de forma de UUID é o mesmo indisponível, e nem toca o banco", async () => {
    render(await tela("nao-e-uuid"));
    expect(resolverPainelPublico).not.toHaveBeenCalled();
    expect(screen.getByText(/indisponível/i)).toBeInTheDocument();
  });

  it("a tela NÃO É INDEXÁVEL — link de cliente não entra em index de busca por acidente", async () => {
    const { metadata } = await import("@/app/painel-publico/[id]/page");
    expect(metadata).toMatchObject({ robots: { index: false, follow: false } });
  });
});
