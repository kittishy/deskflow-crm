/**
 * A PESQUISA DE SATISFAÇÃO PÚBLICA — o cliente responde e a nota fica gravada.
 *
 * A rota é a única coisa que este produto expõe para quem NÃO é cliente: o
 * token é a credencial, a organização sai da LINHA e a escrita é idempotente.
 * As três são testadas aqui com o cliente de banco dublê; o resto (regra de
 * quando perguntar, matemática do NPS) é pura e mora em `lib/nps/*.test.ts`.
 *
 * O dublê é de CADEIA, não de resultado: a rota depende de `eq`/`is` para não
 * gravar por cima da resposta de outro navegador, e um dublê que devolvesse
 * `{data: ...}` pronto deixaria essa parte sem prova nenhuma. Por isso cada
 * chamada é registrada e o teste LÊ a cadeia.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { agregaNps } from "@/lib/nps/agregado";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";

interface LinhaDublê {
  id: string;
  organization_id: string;
  conversation_id: string;
  asked_at: string;
  answered_at: string | null;
  score: number | null;
}

let linha: LinhaDublê | null = null;
let cadeia: { metodo: string; args: unknown[] }[] = [];
let atualizacoes: Record<string, unknown>[] = [];
const auditou = vi.fn();

function clienteDublê() {
  const no = () => {
    const registrar = (metodo: string) => (args: unknown[]) => {
      cadeia.push({ metodo, args });
      return no();
    };
    return {
      select: (args: unknown[]) => registrar("select")(args),
      update: (args: unknown[]) => {
        atualizacoes.push(args as unknown as Record<string, unknown>);
        return registrar("update")(args);
      },
      eq: (coluna: unknown, valor: unknown) => registrar("eq")([coluna, valor]),
      is: (coluna: unknown, valor: unknown) => registrar("is")([coluna, valor]),
      maybeSingle: async () => ({ data: linha, error: null }),
    };
  };
  return { from: () => no() };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteDublê() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
}));
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));

function requisicaoDe(method: "GET" | "POST", corpo?: FormData): Request {
  return new Request(`http://crm.test/api/v1/nps/${TOKEN}`, {
    method,
    ...(corpo ? { body: corpo } : {}),
  });
}

async function chamar(method: "GET" | "POST", token = TOKEN, corpo?: FormData) {
  const { GET, POST } = await import("@/app/api/v1/nps/[token]/route");
  const ctx = { params: Promise.resolve({ token }) };
  const req = requisicaoDe(method, corpo) as never;
  return method === "GET" ? GET(req, ctx) : POST(req, ctx);
}

beforeEach(() => {
  linha = {
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: OUTRA_ORG,
    conversation_id: "44444444-4444-4444-8444-444444444444",
    asked_at: "2026-10-02T12:00:00.000Z",
    answered_at: null,
    score: null,
  };
  cadeia = [];
  atualizacoes = [];
  auditou.mockClear();
});

describe("GET — o convite", () => {
  it("abre o formulário com as onze notas de 0 a 10 e o link que grava nesta mesma rota", async () => {
    const res = await chamar("GET");
    const html = await res.text();
    expect(res.status).toBe(200);
    for (let n = 0; n <= 10; n++) expect(html).toContain(`value="${n}"`);
    expect(html).toContain(`action="/api/v1/nps/${TOKEN}"`);
    expect(html).toContain('name="comentario"');
  });

  it("não devolve o identificador da organização nem o da conversa a quem responde", async () => {
    // A resposta é para o CLIENTE da empresa dona do CRM. O id da organização
    // no HTML viraria vazamento de dado de terceiro em página pública.
    const html = await (await chamar("GET")).text();
    expect(html).not.toContain(OUTRA_ORG);
    expect(html).not.toContain("44444444-4444-4444-8444-444444444444");
  });

  it("quem já respondeu vê a confirmação, e o formulário NÃO é offering de novo", async () => {
    linha = { ...linha!, answered_at: "2026-10-02T13:00:00.000Z", score: 8 };
    const html = await (await chamar("GET")).text();
    expect(html).toContain("já foi registrada");
    expect(html).not.toContain('action="/api/v1/nps/');
  });

  it("token que não é de nenhum convite é 404 e não abre o formulário", async () => {
    linha = null;
    const res = await chamar("GET");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<form");
  });

  it("token fora do formato de UUID é recusado ANTES de qualquer consulta", async () => {
    const res = await chamar("GET", "convite-123");
    expect(res.status).toBe(404);
    expect(cadeia).toEqual([]);
  });

  it("a página da credencial não vai para cache nem vaza o token por Referer", async () => {
    const res = await chamar("GET");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("POST — a resposta", () => {
  it("grava a nota com a organização da LINHA, nunca uma do caminho", async () => {
    const form = new FormData();
    form.set("score", "9");
    form.set("comentario", "  atendimento rápido  ");
    const res = await chamar("POST", TOKEN, form);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Obrigado");
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0]).toMatchObject({ score: 9, comment: "atendimento rápido" });
    expect(atualizacoes[0]?.answered_at).toEqual(expect.any(String));
    // A organização do corpo da resposta é a da linha do convite — um
    // `organization_id` vindo do request permitiria responder POR outra empresa.
    expect(cadeia).toContainEqual({ metodo: "eq", args: ["organization_id", OUTRA_ORG] });
  });

  it("a escrita só passa onde ainda NÃO há resposta", async () => {
    // Dois navegadores com o mesmo link chegam juntos. Sem este `is`, o segundo
    // sobrescreve a nota do primeiro e o agregado passa a contar a última.
    const form = new FormData();
    form.set("score", "10");
    await chamar("POST", TOKEN, form);
    expect(cadeia).toContainEqual({ metodo: "is", args: ["answered_at", null] });
  });

  it("nota fora de 0..10 volta o formulário e NÃO grava", async () => {
    for (const nota of ["11", "-1", "7.5", "dez"]) {
      cadeia = [];
      atualizacoes = [];
      const form = new FormData();
      form.set("score", nota);
      const res = await chamar("POST", TOKEN, form);
      expect(await res.text(), `nota ${nota}`).toContain("<form");
      expect(atualizacoes, `nota ${nota}`).toHaveLength(0);
    }
  });

  it("convite já respondido não é sobrescrito — a segunda resposta é um não-op", async () => {
    linha = { ...linha!, answered_at: "2026-10-02T13:00:00.000Z", score: 3 };
    const form = new FormData();
    form.set("score", "10");
    const res = await chamar("POST", TOKEN, form);
    expect(await res.text()).toContain("já foi registrada");
    expect(atualizacoes).toHaveLength(0);
    expect(auditou).not.toHaveBeenCalled();
  });

  it("comentário acima do teto não grava — é o mesmo teto do CHECK do banco", async () => {
    const form = new FormData();
    form.set("score", "10");
    form.set("comentario", "x".repeat(1001));
    await chamar("POST", TOKEN, form);
    expect(atualizacoes).toHaveLength(0);
  });

  it("responder audita com a organização da linha e sem tomar a nota como log", async () => {
    const form = new FormData();
    form.set("score", "4");
    form.set("comentario", "demorei");
    await chamar("POST", TOKEN, form);
    expect(auditou).toHaveBeenCalledTimes(1);
    const entrada = auditou.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entrada).toMatchObject({
      action: "nps.pesquisa_respondida",
      organizationId: OUTRA_ORG,
      resourceId: linha!.conversation_id,
      bypassedRls: true,
    });
    // O texto do cliente é dado pessoal: entra o_metadata como booleano, nunca
    // a nota em log de aplicação (`lib/audit`).
    expect(entrada.metadata).toEqual({ score: 4, com_comentario: true });
  });
});

describe("a nota gravada alimenta o agregado", () => {
  it("a linha que a rota gravada produz é a que `agregaNps` entende", async () => {
    const form = new FormData();
    form.set("score", "9");
    await chamar("POST", TOKEN, form);
    const gravada = atualizacoes[0] as unknown as LinhaDublê;
    // O agregado lê a LINHA; o Zod e o CHECK garantem a faixa, e aqui a nota vai
    // de 0 a 10 sem nenhum passo de conversão.
    expect(agregaNps([{ score: gravada.score, answered_at: gravada.answered_at }])).toMatchObject({
      respondidas: 1,
      promotores: 1,
      // Uma resposta só não é amostra: `nps: null`, nunca `-100`.
      nps: null,
      taxa_de_resposta: 100,
    });
  });
});
