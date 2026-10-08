import { describe, expect, it } from "vitest";

import { avaliarLimiteDiario, contarAbordagensDeHoje } from "./limite-diario";

const HOJE = "2026-10-06";
const ONTEM = "2026-10-05";

const item = (over: Partial<Parameters<typeof contarAbordagensDeHoje>[0][number]> = {}) => ({
  tipo: "prospeccao" as const,
  status: "sent",
  enviadoEm: `${HOJE}T10:00:00.000Z`,
  criadoEm: `${HOJE}T09:00:00.000Z`,
  ...over,
});

describe("contarAbordagensDeHoje", () => {
  it("conta só as abordagens de hoje que ainda valem", () => {
    const itens = [
      item({ status: "sent" }),
      item({ status: "pending", enviadoEm: null }),
      item({ status: "processing", enviadoEm: null }),
      item({ status: "cancelled", enviadoEm: null }),
      item({ status: "paused", enviadoEm: null }),
      item({ enviadoEm: `${ONTEM}T10:00:00.000Z`, criadoEm: `${ONTEM}T09:00:00.000Z` }),
    ];
    // 3 valem (uma enviada, uma pendente, uma em processamento). Cancelada,
    // pausada e a de ontem não contam.
    expect(contarAbordagensDeHoje(itens, HOJE)).toBe(3);
  });

  it("não conta resposta, conversa ativa nem follow-up", () => {
    const itens = [
      item({ tipo: "resposta" }),
      item({ tipo: "conversa_ativa" }),
      item({ tipo: "follow_up" }),
      item(),
    ];
    expect(contarAbordagensDeHoje(itens, HOJE)).toBe(1);
  });

  it("item pendido de ontem só conta se sua criação for de ontem", () => {
    const pendenteDeOntem = item({ status: "pending", enviadoEm: null, criadoEm: `${ONTEM}T09:00:00.000Z` });
    expect(contarAbordagensDeHoje([pendenteDeOntem], HOJE)).toBe(0);
  });
});

describe("avaliarLimiteDiario", () => {
  it("permite enquanto sobrar orçamento", () => {
    expect(avaliarLimiteDiario({ tipo: "prospeccao", limite: 20, abordagensHoje: 7 })).toEqual({
      permite: true,
      restantes: 13,
    });
  });

  it("BLOQUEIA a prospecção no limite, com motivo para a tela explicar", () => {
    expect(avaliarLimiteDiario({ tipo: "prospeccao", limite: 20, abordagensHoje: 20 })).toEqual({
      permite: false,
      motivo: "limite_diario_de_abordagens",
      restantes: 0,
    });
  });

  it("nunca bloqueia resposta — nem com o teto estourado", () => {
    // O cenário que o dono pediu: limite atingido, e a resposta continua saindo.
    const estourado = { limite: 20, abordagensHoje: 99 };
    expect(avaliarLimiteDiario({ tipo: "resposta", ...estourado }).permite).toBe(true);
    expect(avaliarLimiteDiario({ tipo: "conversa_ativa", ...estourado }).permite).toBe(true);
    expect(avaliarLimiteDiario({ tipo: "follow_up", ...estourado }).permite).toBe(true);
  });

  it("limite zero desliga o teto", () => {
    expect(avaliarLimiteDiario({ tipo: "prospeccao", limite: 0, abordagensHoje: 500 })).toEqual({
      permite: true,
      restantes: null,
    });
  });

  it("o padrão preparado é 20 abordagens por dia", () => {
    expect(avaliarLimiteDiario({ tipo: "prospeccao", limite: 20, abordagensHoje: 19 }).permite).toBe(true);
    expect(avaliarLimiteDiario({ tipo: "prospeccao", limite: 20, abordagensHoje: 20 }).permite).toBe(false);
    expect(avaliarLimiteDiario({ tipo: "resposta", limite: 20, abordagensHoje: 20 }).permite).toBe(true);
  });
});