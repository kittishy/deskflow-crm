/**
 * A ORGANIZAÇÃO DO PAINEL SAI DA LINHA, NUNCA DE QUEM PERGUNTA.
 *
 * O painel público não tem sessão para consultar: a credencial é o UUID da
 * linha. Isso faz da linha a única fonte de `organization_id` — e o serviço
 * role bypassa RLS, então um `organization_id` aceito do pedido seria um painel
 * capaz de servir as métricas de qualquer outra organização. Este arquivo é o
 * portão: cada caso aqui existe porque uma leitura errada dessa coluna devolve
 * número de cliente alheio com aparência de número próprio.
 *
 * O dublê IGNORA a projeção do `select` e devolve a linha INTEIRA, com nome e
 * telefone dentro, como faria um duplo descuidado. É por isso que o teste do
 * vazamento de PII mede algo: se a agregação montasse o payload a partir da
 * linha crua em vez das colunas pedidas, aqui apareceria o telefone.
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { MOTIVO_DA_TRANSFERENCIA } from "@/lib/leads/motivo-da-perda";
import { lerMetricasPublicas, resolverPainelPublico } from "@/lib/painel-publico/resolver";

const PAINEL = "33333333-3333-4333-8333-333333333333";
const ORG_DONA = "22222222-2222-4222-8222-222222222222";
const AGORA = new Date("2026-10-02T12:00:00.000Z");

interface Captura {
  filtros: Record<string, Array<{ coluna: string; valor: unknown }>>;
  rpcs: Array<{ nome: string; args: Record<string, unknown> }>;
}

type Opcoes = {
  painel?: Record<string, unknown> | null;
  erroDoPainel?: { message: string } | null;
  contagens?: Record<string, number>;
  leadsPerdidos?: Array<Record<string, unknown>>;
  erroDoAtrito?: { message: string } | null;
  atrito?: Record<string, unknown> | null;
  settings?: Record<string, unknown>;
};

/** Dublê de client: registra filtro por tabela e devolve a linha inteira. */
function duble(opcoes: Opcoes = {}): { client: SupabaseClient; captura: Captura } {
  const captura: Captura = { filtros: {}, rpcs: [] };
  const contagens = opcoes.contagens ?? { won: 0, lost: 0, conversas: 0 };

  const client = {
    from(tabela: string) {
      const filtros: Array<{ coluna: string; valor: unknown }> = [];
      captura.filtros[tabela] ??= filtros;
      /** `head: true` é o que separa "conta" de "traz as linhas". */
      let cabecalho = false;
      const conta = (coluna: string, valor: unknown) => {
        filtros.push({ coluna, valor });
        return cadeia;
      };

      const cadeia = {
        select: (_colunas?: string, opcoesSelect?: { head?: boolean; count?: string }) => {
          cabecalho = opcoesSelect?.head === true;
          return cadeia;
        },
        eq: conta,
        in: conta,
        gte: conta,
        lt: conta,
        order: () => cadeia,
        limit: () => cadeia,
        count: async () => {
          const status = filtros.find((f) => f.coluna === "status")?.valor;
          if (tabela === "conversations") return contagens.conversas ?? 0;
          if (status === "won") return contagens.won ?? 0;
          if (status === "lost") return contagens.lost ?? 0;
          return 0;
        },
        maybeSingle: async () => {
          if (tabela === "organizations") {
            return { data: { settings: opcoes.settings ?? {} }, error: null };
          }
          if (tabela === "public_panels") {
            const erro = opcoes.erroDoPainel ?? null;
            const painel = opcoes.painel ?? null;
            if (erro) return { data: null, error: erro };
            // O banco FILTRA `enabled = true`; o dublê filtra igual, senão o
            // caso do painel desligado provaria o dublê e não a rota.
            const exigeAtivo = filtros.some((f) => f.coluna === "enabled" && f.valor === true);
            const Some = painel !== null && (!exigeAtivo || painel.enabled === true);
            return { data: Some ? painel : null, error: null };
          }
          return { data: null, error: null };
        },
        then: (r: (v: unknown) => unknown) => {
          if (tabela === "public_panels") {
            const erro = opcoes.erroDoPainel ?? null;
            const painel = erro ? null : (opcoes.painel ?? null);
            return r({ data: painel ? [painel] : [], error: erro }) as unknown;
          }
          if (tabela === "crm_leads" && cabecalho) {
            const status = filtros.find((f) => f.coluna === "status")?.valor;
            const count = status === "won" ? (contagens.won ?? 0) : (contagens.lost ?? 0);
            return r({ data: null, count, error: null }) as unknown;
          }
          if (tabela === "crm_leads") {
            return r({ data: opcoes.leadsPerdidos ?? [], error: null }) as unknown;
          }
          if (tabela === "conversations" && cabecalho) {
            return r({ data: null, count: contagens.conversas ?? 0, error: null }) as unknown;
          }
          return r({ data: [], error: null }) as unknown;
        },
      };
      return cadeia;
    },
    rpc: async (nome: string, args?: Record<string, unknown>) => {
      captura.rpcs.push({ nome, args: args ?? {} });
      if (nome === "fn_atrito_metrics") {
        return {
          data: opcoes.erroDoAtrito ? null : (opcoes.atrito ?? null),
          error: opcoes.erroDoAtrito ?? null,
        };
      }
      return { data: null, error: null };
    },
  };
  return { client: client as unknown as SupabaseClient, captura };
}

function painelAtivo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAINEL,
    organization_id: ORG_DONA,
    enabled: true,
    title: "Painel da Clínica Aurora",
    window_days: 30,
    created_at: "2026-09-01T00:00:00.000Z",
    // Campo que a linha NÃO tem e que ninguém pode ler: prova de que a
    // projeção do painel é fechada.
    organization_id_alheio: "99999999-9999-4999-8999-999999999999",
    ...over,
  };
}

describe("resolverPainelPublico", () => {
  it("devolve a organização DA LINHA e a janela que ela pediu", async () => {
    const { client } = duble({ painel: painelAtivo({ window_days: 7 }) });
    const painel = await resolverPainelPublico(client, PAINEL);

    expect(painel).toEqual({
      id: PAINEL,
      organizationId: ORG_DONA,
      title: "Painel da Clínica Aurora",
      windowDays: 7,
    });
  });

  it("PAINEL DESLIGADO não resolve — e responde o mesmo que painel inexistente", async () => {
    const desligado = duble({ painel: painelAtivo({ enabled: false }) });
    const inexistente = duble({ painel: null });

    expect(await resolverPainelPublico(desligado.client, PAINEL)).toBeNull();
    expect(await resolverPainelPublico(inexistente.client, PAINEL)).toBeNull();
  });

  it("banco fora do ar não vira painel: null, e a diferença é indiscernível de propósito", async () => {
    const { client } = duble({ erroDoPainel: { message: "connection failure" } });
    expect(await resolverPainelPublico(client, PAINEL)).toBeNull();
  });

  it("a busca FILTRA por enabled = true no banco, e não depois em JavaScript", async () => {
    const { client, captura } = duble({ painel: painelAtivo() });
    await resolverPainelPublico(client, PAINEL);
    expect(captura.filtros.public_panels).toEqual(
      expect.arrayContaining([{ coluna: "id", valor: PAINEL }]),
    );
    // O filtro de enabled existe na consulta; `duble` devolve a linha como vier,
    // então a única prova possível é o filtro.
    expect(captura.filtros.public_panels).toEqual(
      expect.arrayContaining([{ coluna: "enabled", valor: true }]),
    );
  });

  it("só as colunas do painel são lidas — o id da linha não carrega segredo de org alheia", async () => {
    const { client } = duble({ painel: painelAtivo() });
    const devolvido = await resolverPainelPublico(client, PAINEL);
    // `organization_id_alheio` existe no dublê justamente para alguém escrever
    // uma linha de return que a carregue. Ela não volta: o objeto devolvido
    // tem quatro campos.
    expect(Object.keys(devolvido ?? {}).sort()).toEqual([
      "id",
      "organizationId",
      "title",
      "windowDays",
    ]);
  });
});

describe("lerMetricasPublicas", () => {
  const painel = {
    id: PAINEL,
    organizationId: ORG_DONA,
    title: "Painel da Clínica Aurora",
    windowDays: 30,
  };

  it("conta ganhos, perdas e conversas DA ORGANIZAÇÃO DO PAINEL", async () => {
    const { client, captura } = duble({
      painel: painelAtivo(),
      contagens: { won: 8, lost: 2, conversas: 40 },
    });

    const metricas = await lerMetricasPublicas(client, painel, AGORA);

    expect(metricas.resumo).toMatchObject({
      negocios_ganhos: 8,
      negocios_perdidos: 2,
      negocios_encerrados: 10,
      conversas: 40,
      taxa_de_conversao: 0.8,
    });
    expect(metricas.janela.dias).toBe(30);
    // TODO acesso ao dado passa pelo filtro de organização.
    for (const tabela of ["crm_leads", "conversations"]) {
      expect(captura.filtros[tabela]).toEqual(
        expect.arrayContaining([{ coluna: "organization_id", valor: ORG_DONA }]),
      );
    }
  });

  it("o atrito é lido pelo RPC com o p_org DA LINHA — e pela janela do painel", async () => {
    const { client, captura } = duble({ painel: painelAtivo() });
    await lerMetricasPublicas(client, painel, AGORA);

    const rpc = captura.rpcs.find((r) => r.nome === "fn_atrito_metrics");
    expect(rpc?.args).toMatchObject({
      p_org: ORG_DONA,
      p_from: "2026-09-02T12:00:00.000Z",
      p_to: AGORA.toISOString(),
    });
  });

  it("a régua do abandono vem da organização, não do default — número sem régua não se compara", async () => {
    const { client, captura } = duble({
      painel: painelAtivo(),
      settings: { atrito: { abandono_horas: 24 } },
    });
    await lerMetricasPublicas(client, painel, AGORA);

    const rpc = captura.rpcs.find((r) => r.nome === "fn_atrito_metrics");
    expect(rpc?.args.p_abandono_horas).toBe(24);
    expect(captura.filtros.organizations).toEqual(
      expect.arrayContaining([{ coluna: "id", valor: ORG_DONA }]),
    );
  });

  it("RPC de atrito fora do ar NÃO publica zero — as medidas saem vazias e o resto continua", async () => {
    const { client } = duble({
      painel: painelAtivo(),
      contagens: { won: 3, lost: 1, conversas: 12 },
      erroDoAtrito: { message: "statement timeout" },
    });

    const metricas = await lerMetricasPublicas(client, painel, AGORA);

    expect(metricas.medidas).toEqual([]);
    expect(metricas.resumo.negocios_ganhos).toBe(3);
  });

  it("NENHUM nome e NENHUM telefone chega ao payload, mesmo vindo na linha crua", async () => {
    const { client } = duble({
      painel: painelAtivo(),
      contagens: { won: 1, lost: 1, conversas: 2 },
      leadsPerdidos: [
        {
          lost_reason: "Preço",
          lost_from_stage_id: "etapa-1",
          value_cents: 1000,
          currency: "BRL",
          pipeline_id: "funil-1",
          // Campos que a linha de `crm_leads` tem e que um painel público
          // jamais pode carregar adiante:
          contact_id: "contato-9",
          owner_user_id: "11111111-1111-4111-8111-111111111111",
        },
      ],
    });

    const serializado = JSON.stringify(await lerMetricasPublicas(client, painel, AGORA));

    expect(serializado).not.toContain("contato-9");
    expect(serializado).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(serializado).not.toContain("value_cents");
  });

  it("as perdas saem pela CATEGORIA do funil, com o total que a agregação entregou", async () => {
    const { client } = duble({
      painel: painelAtivo(),
      contagens: { won: 0, lost: 4, conversas: 9 },
      leadsPerdidos: [
        {
          lost_reason: "Preço",
          lost_from_stage_id: "e1",
          value_cents: 100,
          currency: "BRL",
          pipeline_id: "f1",
        },
        {
          lost_reason: "Preço",
          lost_from_stage_id: "e2",
          value_cents: 200,
          currency: "BRL",
          pipeline_id: "f1",
        },
        {
          lost_reason: "Sem retorno",
          lost_from_stage_id: "e2",
          value_cents: 0,
          currency: "BRL",
          pipeline_id: "f1",
        },
        {
          lost_reason: MOTIVO_DA_TRANSFERENCIA,
          lost_from_stage_id: "e2",
          value_cents: 0,
          currency: "BRL",
          pipeline_id: "f1",
        },
      ],
    });

    const metricas = await lerMetricasPublicas(client, painel, AGORA);

    // A transferência entre funis NÃO é perda (migration 0266): o total conta 3.
    expect(metricas.perda.total).toBe(3);
    expect(metricas.perda.por_categoria.length).toBeGreaterThan(0);
  });
});
