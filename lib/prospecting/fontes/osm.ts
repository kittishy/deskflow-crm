import { ProspectingError } from "../provider";
import { normalizarTelefoneBr, type Prospect } from "../schema";

/**
 * FONTE GRATUITA — OpenStreetMap, sem chave e sem custo.
 *
 * A busca paga (Apify/Google Places) traz telefone, nota e avaliações; esta
 * traz o que o mapa colaborativo tem: nome, endereço, telefone QUANDO alguém
 * cadastrou a tag, site QUANDO existe. Nota e avaliações NÃO existem no OSM —
 * os campos voltam `null` por honestidade, nunca zero inventado.
 *
 * Limites honestos desta fonte, lidos antes de prometer:
 *
 *  - Geocodificação pelo Nominatim (1 request por busca) e UMA consulta
 *    Overpass por busca. A política de uso do Nominatim pede 1 req/s e
 *    User-Agent identificável — o volume daqui (1 por busca manual) cumpre
 *    com folga, e o header abaixo identifica o produto.
 *  - Cobertura depende de voluntários: capitais e centros vão bem, cidade
 *    pequena pode voltar vazia. Vazio aqui significa "o mapa não tem", não
 *    "não existem empresas" — a tela precisa dizer isso.
 *  - Telefone é RARO no OSM. Candidatos sem telefone entram na lista do
 *    mesmo jeito (a doutrina de mineração manda não descartar por falta de
 *    um sinal), mas a ativação da campanha os marca `skipped` — abordar
 *    exige telefone, e isso não muda.
 *  - Sem `place_id` do Google: a chave vira `osm:{tipo}/{id}`, estável por
 *    ser o id do próprio elemento no mapa.
 */

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const RAIO_METROS = 10000;
const AGENTE_HTTP = "DeskflowCRM/1.0 (busca de empresas no mapa colaborativo)";

export interface ElementoOsm {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface CentroOsm {
  lat: number;
  lng: number;
  nome: string;
}

/** Nicho em PT-BR → filtros de tag do OSM. O nome do negócio SEMPRE entra como
 *  ramo extra (`name` com regex), porque "Marmoraria X" casa pelo nome mesmo
 *  quando o mapeador não marcou a tag certa. */
const REGRAS_DE_NICHO: { termos: string[]; filtros: string[] }[] = [
  { termos: ["marmoraria", "marmore", "granito", "pedra"], filtros: ['["craft"~"stonemason"]', '["shop"~"tiles|stone"]'] },
  { termos: ["academia", "crossfit", "pilates", "musculacao", "funcional"], filtros: ['["leisure"~"fitness_centre|sports_centre"]', '["shop"~"sports"]'] },
  { termos: ["restaurante"], filtros: ['["amenity"~"restaurant|food_court"]'] },
  { termos: ["pizzaria", "hamburgueria", "lanchonete", "cafeteria", "sorveteria", "acai"], filtros: ['["amenity"~"fast_food|restaurant|cafe|ice_cream"]'] },
  { termos: ["bar ", "boteco", "cervejaria", "pub"], filtros: ['["amenity"~"bar|pub|biergarten"]'] },
  { termos: ["padaria", "confeitaria", "bolo"], filtros: ['["shop"~"bakery|pastry|confectionery"]'] },
  { termos: ["estetica", "beleza", "salao", "barbearia", "esmalteria", "depilacao", "massagem", "spa"], filtros: ['["shop"~"beauty|hairdresser|nails|massage|cosmetics"]'] },
  { termos: ["moveis", "marcenaria", "planejados", "closet"], filtros: ['["shop"~"furniture|kitchen|bed|interior_decoration"]', '["craft"~"carpenter|joiner|cabinet_maker|furniture"]'] },
  { termos: ["pet", "veterinaria", "banho e tosa", "tosa"], filtros: ['["shop"~"pet|pet_grooming"]', '["amenity"~"veterinary"]'] },
  { termos: ["oficina", "mecanica", "auto center", "pneu"], filtros: ['["shop"~"car_repair|car|motorcycle|bicycle|tyres|car_parts"]'] },
  { termos: ["lava car", "lavagem", "estetica automotiva"], filtros: ['["amenity"~"car_wash"]', '["shop"~"car"]'] },
  { termos: ["farmacia", "drogaria"], filtros: ['["amenity"~"pharmacy"]'] },
  { termos: ["mercado", "supermercado", "mercearia", "hortifruti"], filtros: ['["shop"~"supermarket|convenience|grocery|greengrocer"]'] },
  { termos: ["roupa", "moda", "boutique", "calcado", "sapataria"], filtros: ['["shop"~"clothes|shoes|fashion|boutique"]'] },
  { termos: ["otica", "oculos"], filtros: ['["shop"~"optician"]'] },
  { termos: ["papelaria", "livraria"], filtros: ['["shop"~"stationery|books"]'] },
  { termos: ["hotel", "pousada", "hostel", "motel"], filtros: ['["tourism"~"hotel|guest_house|hostel|motel"]'] },
  { termos: ["imobiliaria", "imoveis"], filtros: ['["office"~"estate_agent"]'] },
  { termos: ["advocacia", "advogado"], filtros: ['["office"~"lawyer"]'] },
  { termos: ["contabil", "contabilidade"], filtros: ['["office"~"accountant|consulting"]'] },
  { termos: ["odonto", "dentista", "clinica"], filtros: ['["healthcare"~"dentist|doctor|clinic"]', '["amenity"~"clinic|doctors"]'] },
  { termos: ["escola", "curso", "idiomas"], filtros: ['["amenity"~"school|college|language_school|music_school"]'] },
  { termos: ["igreja", "templo"], filtros: ['["amenity"~"place_of_worship"]'] },
];

function semAcento(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Palavras significativas do nicho para o ramo `name` (ignora conectivos). */
export function palavrasDoNicho(nicho: string): string[] {
  const ignorar = new Set(["de", "da", "do", "das", "dos", "e", "para", "com", "em", "no", "na", "a", "o", "as", "os"]);
  return semAcento(nicho)
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 4 && !ignorar.has(p))
    .slice(0, 3);
}

/** Filtros de tag para o nicho; nicho desconhecido volta vazio (vale só o nome). */
export function filtrosDeNicho(nicho: string): string[] {
  const normalizado = ` ${semAcento(nicho)} `;
  for (const regra of REGRAS_DE_NICHO) {
    if (regra.termos.some((t) => normalizado.includes(` ${t} `) || normalizado.includes(` ${t}`)))
      return regra.filtros;
  }
  return [];
}

/** Monta a consulta Overpass: ramos por tag (quando o nicho mapeia) + SEMPRE o
 *  ramo por nome, que pega "Marmoraria Silva" mesmo sem tag. */
export function montarConsultaOverpass(nicho: string, centro: CentroOsm, raioMetros = RAIO_METROS): string {
  const ramos: string[] = [];
  for (const filtro of filtrosDeNicho(nicho)) {
    for (const tipo of ["node", "way"] as const) {
      ramos.push(`  ${tipo}${filtro}(around:${raioMetros},${centro.lat},${centro.lng});`);
    }
  }
  const palavras = palavrasDoNicho(nicho);
  if (palavras.length > 0) {
    const regex = palavras.map(escaparRegex).join("|");
    for (const tipo of ["node", "way"] as const) {
      ramos.push(`  ${tipo}["name"~"${regex}",i](around:${raioMetros},${centro.lat},${centro.lng});`);
    }
  }
  return `[out:json][timeout:25];\n(\n${ramos.join("\n")}\n);\nout center tags;`;
}

async function lerJson(res: Response, origem: string): Promise<unknown> {
  if (!res.ok)
    throw new ProspectingError(
      origem === "nominatim"
        ? "O mapa gratuito não respondeu agora. Tente de novo em alguns segundos."
        : "O mapa gratuito não respondeu agora. Tente de novo em alguns segundos.",
      502,
    );
  return res.json();
}

/** Geocodifica "Niterói, RJ" → coordenadas, pelo Nominatim (grátis, sem chave). */
export async function geocodificarLocal(local: string): Promise<CentroOsm> {
  let res: Response;
  try {
    const url = `${NOMINATIM}?${new URLSearchParams({
      format: "jsonv2",
      limit: "1",
      countrycodes: "br",
      q: local.slice(0, 160),
    })}`;
    res = await fetch(url, {
      headers: { "User-Agent": AGENTE_HTTP, Accept: "application/json", "Accept-Language": "pt-BR" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ProspectingError("O mapa gratuito não respondeu agora. Tente de novo em alguns segundos.", 502);
  }
  const lista = (await lerJson(res, "nominatim")) as { lat?: string; lon?: string; display_name?: string }[];
  const primeiro = lista[0];
  const lat = Number(primeiro?.lat);
  const lng = Number(primeiro?.lon);
  if (!primeiro || !Number.isFinite(lat) || !Number.isFinite(lng))
    throw new ProspectingError(
      "Não encontrei essa região no mapa gratuito. Tente com cidade e estado (ex.: Niterói, RJ).",
      422,
    );
  return { lat, lng, nome: primeiro.display_name ?? local };
}

/** Um elemento do Overpass → Prospect. Telefone sai das tags de contato QUANDO
 *  existem; nota e avaliações voltam `null` porque o OSM não tem. */
export function normalizeOsmProspect(el: ElementoOsm): Prospect | null {
  const tags = el.tags ?? {};
  const nome = (tags.name ?? "").trim().slice(0, 200);
  if (!nome) return null;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const telefone = normalizarTelefoneBr(
    tags["contact:phone"] || tags.phone || tags["contact:mobile"] || tags.mobile || "",
  );
  const site = (tags.website || tags["contact:website"] || "").trim().slice(0, 500) || null;
  const categoria =
    tags.shop || tags.craft || tags.amenity || tags.leisure || tags.tourism || tags.office || tags.healthcare || null;
  const endereco = [
    [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(", "),
    tags["addr:suburb"] || tags["addr:neighbourhood"] || null,
    tags["addr:city"] || tags["addr:town"] || tags["addr:village"] || null,
    tags["addr:state"] || null,
  ]
    .filter((p) => p && p.length > 0)
    .join(" — ")
    .slice(0, 500) || null;
  return {
    key: `osm:${el.type}/${el.id}`,
    name: nome,
    phone: telefone,
    website: site,
    category: categoria ? String(categoria).slice(0, 500) : null,
    address: endereco,
    maps_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    rating: null,
    reviews: null,
    emails: [],
    socials: [],
  };
}

/** Busca completa na fonte gratuita: geocodifica e consulta o Overpass UMA vez. */
export async function buscarOsm(nicho: string, local: string, limite: number): Promise<{ centro: CentroOsm; prospects: Prospect[] }> {
  const centro = await geocodificarLocal(local);
  const consulta = montarConsultaOverpass(nicho, centro);
  let res: Response;
  try {
    res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "User-Agent": AGENTE_HTTP, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: `data=${encodeURIComponent(consulta)}`,
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new ProspectingError("O mapa gratuito não respondeu agora. Tente de novo em alguns segundos.", 502);
  }
  const corpo = (await lerJson(res, "overpass")) as { elements?: ElementoOsm[] };
  const vistos = new Set<string>();
  const prospects: Prospect[] = [];
  for (const el of corpo.elements ?? []) {
    const p = normalizeOsmProspect(el);
    if (!p || vistos.has(p.key)) continue;
    vistos.add(p.key);
    prospects.push(p);
    if (prospects.length >= limite) break;
  }
  return { centro, prospects };
}
