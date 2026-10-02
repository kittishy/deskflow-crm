import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buscarOsm,
  filtrosDeNicho,
  montarConsultaOverpass,
  normalizeOsmProspect,
  palavrasDoNicho,
  type ElementoOsm,
} from "./osm";
import { normalizarTelefoneBr } from "../schema";
import { ProspectingError } from "../provider";

afterEach(() => {
  vi.unstubAllGlobals();
});

function elemento(parcial: Partial<ElementoOsm> & { tags?: Record<string, string> }): ElementoOsm {
  return { type: "node", id: 1, lat: -22.9, lon: -43.1, ...parcial };
}

describe("normalizarTelefoneBr (compartilhado Apify/OSM)", () => {
  it("aceita fixo e celular com DDD", () => {
    expect(normalizarTelefoneBr("(21) 99999-0000")).toBe("+5521999990000");
    expect(normalizarTelefoneBr("2133334444")).toBe("+552133334444");
  });

  it("preserva E.164 estrangeiro válido e recusa o inválido", () => {
    expect(normalizarTelefoneBr("+55 21 99999-0000")).toBe("+5521999990000");
    expect(normalizarTelefoneBr("+1 212 555 1234")).toBeNull();
  });

  it("recusa lixo", () => {
    expect(normalizarTelefoneBr("")).toBeNull();
    expect(normalizarTelefoneBr("123")).toBeNull();
  });
});

describe("normalizeOsmProspect", () => {
  it("mapeia tags completas para Prospect", () => {
    const p = normalizeOsmProspect(
      elemento({
        type: "node",
        id: 123,
        tags: {
          name: "Marmoraria Silva",
          shop: "tiles",
          phone: "(21) 99999-0000",
          website: "https://marmoraria.exemplo",
          "addr:street": "Rua das Pedras",
          "addr:housenumber": "100",
          "addr:suburb": "Centro",
          "addr:city": "Niterói",
          "addr:state": "RJ",
        },
      }),
    );
    expect(p).not.toBeNull();
    expect(p!.key).toBe("osm:node/123");
    expect(p!.name).toBe("Marmoraria Silva");
    expect(p!.phone).toBe("+5521999990000");
    expect(p!.website).toBe("https://marmoraria.exemplo");
    expect(p!.category).toBe("tiles");
    expect(p!.address).toBe("Rua das Pedras, 100 — Centro — Niterói — RJ");
    expect(p!.maps_url).toBe("https://www.openstreetmap.org/node/123");
    // O OSM não tem reputação: null honesto, nunca zero inventado.
    expect(p!.rating).toBeNull();
    expect(p!.reviews).toBeNull();
    expect(p!.emails).toEqual([]);
    expect(p!.socials).toEqual([]);
  });

  it("lê coordenadas do centro em ways", () => {
    const p = normalizeOsmProspect(
      elemento({ type: "way", id: 9, lat: undefined, lon: undefined, center: { lat: -23.5, lon: -46.6 }, tags: { name: "Academia X" } }),
    );
    expect(p?.key).toBe("osm:way/9");
  });

  it("descarta sem nome e sem coordenada", () => {
    expect(normalizeOsmProspect(elemento({ tags: { shop: "tiles" } }))).toBeNull();
    expect(normalizeOsmProspect(elemento({ lat: undefined, lon: undefined, tags: { name: "Sem lugar" } }))).toBeNull();
  });

  it("sem telefone não é descarte — vira lista para enriquecer depois", () => {
    const p = normalizeOsmProspect(elemento({ tags: { name: "Padaria Pão" } }));
    expect(p?.phone).toBeNull();
  });
});

describe("filtrosDeNicho", () => {
  it("marmoraria casa em craft e shop", () => {
    const filtros = filtrosDeNicho("marmorarias");
    expect(filtros.some((f) => f.includes("stonemason"))).toBe(true);
    expect(filtros.some((f) => f.includes("tiles"))).toBe(true);
  });

  it("nicho desconhecido volta vazio (vale só o nome)", () => {
    expect(filtrosDeNicho("consultoria quântica transpessoal")).toEqual([]);
  });
});

describe("palavrasDoNicho", () => {
  it("ignora conectivos e corta em três", () => {
    expect(palavrasDoNicho("clínica de estética avançada da barra")).toEqual([
      "clinica",
      "estetica",
      "avancada",
    ]);
  });
});

describe("montarConsultaOverpass", () => {
  it("traz ramos de tag e de nome, com centro e raio", () => {
    const q = montarConsultaOverpass("marmorarias", { lat: -22.9, lng: -43.1, nome: "Niterói" });
    expect(q).toContain("[out:json][timeout:25]");
    expect(q).toContain("stonemason");
    expect(q).toContain('"name"~"marmorarias"');
    expect(q).toContain("around:10000,-22.9,-43.1");
    expect(q).toContain("out center tags;");
  });

  it("escapa regex do nicho", () => {
    const q = montarConsultaOverpass(" Loja (matriz) ", { lat: 0, lng: 0, nome: "X" });
    expect(q).toContain('"name"~"loja|matriz"');
  });
});

describe("buscarOsm (com fetch dublado)", () => {
  function rede(nominatim: unknown, overpass: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const corpo = String(url).includes("nominatim") ? nominatim : overpass;
        return { ok: true, json: async () => corpo } as unknown as Response;
      }),
    );
  }

  it("geocodifica e consulta uma vez, fatiando no limite", async () => {
    rede(
      [{ lat: "-22.9", lon: "-43.1", display_name: "Niterói, RJ" }],
      {
        elements: [
          { type: "node", id: 1, lat: -22.9, lon: -43.1, tags: { name: "A", phone: "21999990000" } },
          { type: "node", id: 2, lat: -22.9, lon: -43.1, tags: { name: "B" } },
          { type: "node", id: 1, lat: -22.9, lon: -43.1, tags: { name: "A dup" } },
        ],
      },
    );
    const { centro, prospects } = await buscarOsm("marmorarias", "Niterói, RJ", 10);
    expect(centro.nome).toBe("Niterói, RJ");
    expect(prospects.map((p) => p.key)).toEqual(["osm:node/1", "osm:node/2"]);
    expect(prospects[0]!.phone).toBe("+5521999990000");
  });

  it("região desconhecida vira 422 com orientação", async () => {
    rede([], { elements: [] });
    await expect(buscarOsm("x", "lugar que não existe", 10)).rejects.toMatchObject({
      status: 422,
    });
    try {
      await buscarOsm("x", "lugar que não existe", 10);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProspectingError);
    }
  });
});
