import { describe, expect, it } from "vitest";

import { filtrosAtivosDoKanban } from "./filtros-ativos";

describe("filtrosAtivosDoKanban", () => {
  it("sem filtros devolve lista vazia", () => {
    expect(filtrosAtivosDoKanban({})).toEqual([]);
    expect(filtrosAtivosDoKanban({ status: "all" })).toEqual([]);
    expect(filtrosAtivosDoKanban({ owner: "any" })).toEqual([]);
  });

  it("owner ligado vira Responsável", () => {
    expect(filtrosAtivosDoKanban({ owner: "user-1" })).toEqual(["Responsável"]);
    expect(filtrosAtivosDoKanban({ owner: "unassigned" })).toEqual(["Responsável"]);
    expect(filtrosAtivosDoKanban({ owner: "agent:a1" })).toEqual(["Responsável"]);
  });

  it("status diferente de all vira Status", () => {
    expect(filtrosAtivosDoKanban({ status: "open" })).toEqual(["Status"]);
    expect(filtrosAtivosDoKanban({ status: "lost" })).toEqual(["Status"]);
  });

  it("tag string ou array vira Etiqueta", () => {
    expect(filtrosAtivosDoKanban({ tag: "vip" })).toEqual(["Etiqueta"]);
    expect(filtrosAtivosDoKanban({ tag: ["vip", "orçamento"] })).toEqual(["Etiqueta"]);
    expect(filtrosAtivosDoKanban({ tag: [] })).toEqual([]);
  });

  it("modo de etiqueta sozinho não restringe o resultado", () => {
    expect(filtrosAtivosDoKanban({ tagMode: "ou" })).toEqual([]);
    expect(filtrosAtivosDoKanban({ tag: [], tagMode: "ou" })).toEqual([]);
    expect(filtrosAtivosDoKanban({ tag: ["vip"], tagMode: "ou" })).toEqual(["Etiqueta"]);
    expect(filtrosAtivosDoKanban({ tagMode: "e" })).toEqual([]);
  });

  it("nomeia o modo OU apenas quando há etiquetas para combinar", () => {
    expect(filtrosAtivosDoKanban({ tag: ["vip", "orçamento"], tagMode: "ou" })).toEqual([
      "Etiqueta",
      "Modo: OU",
    ]);
  });

  it("search vira Busca", () => {
    expect(filtrosAtivosDoKanban({ search: "padaria" })).toEqual(["Busca"]);
    expect(filtrosAtivosDoKanban({ search: "   " })).toEqual([]);
  });

  it("faixa de valor vira Valor mínimo / Valor máximo", () => {
    expect(filtrosAtivosDoKanban({ valueCentsMin: 100 })).toEqual(["Valor mínimo"]);
    expect(filtrosAtivosDoKanban({ valueCentsMax: 500 })).toEqual(["Valor máximo"]);
    expect(filtrosAtivosDoKanban({ valueCentsMin: null, valueCentsMax: null })).toEqual([]);
  });

  it("overdueOnly vira Apenas atrasados", () => {
    expect(filtrosAtivosDoKanban({ overdueOnly: true })).toEqual(["Apenas atrasados"]);
    expect(filtrosAtivosDoKanban({ overdueOnly: false })).toEqual([]);
  });

  it("lostReason e lostCategory viram Motivo de perda e Categoria", () => {
    expect(filtrosAtivosDoKanban({ lostReason: "preço" })).toEqual(["Motivo de perda"]);
    expect(filtrosAtivosDoKanban({ lostCategory: "preço" })).toEqual(["Categoria"]);
  });

  it("combinação mantém ordem estável", () => {
    expect(
      filtrosAtivosDoKanban({
        owner: "user-1",
        status: "open",
        tag: ["vip", "orçamento"],
        tagMode: "ou",
        search: "padaria",
        valueCentsMin: 100,
        valueCentsMax: 500,
        overdueOnly: true,
        lostReason: "preço",
        lostCategory: "preço",
      }),
    ).toEqual([
      "Responsável",
      "Status",
      "Etiqueta",
      "Modo: OU",
      "Busca",
      "Valor mínimo",
      "Valor máximo",
      "Apenas atrasados",
      "Motivo de perda",
      "Categoria",
    ]);
  });
});
