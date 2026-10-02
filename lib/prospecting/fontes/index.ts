/**
 * FONTES DE BUSCA DA PROSPECÇÃO — o contrato é um só, o custo não.
 *
 * - `osm` (padrão): OpenStreetMap via Overpass + Nominatim. Gratuita, sem
 *   chave, sem custo. Traz nome, endereço e telefone quando o mapa tem;
 *   nota e avaliações não existem lá e voltam `null`.
 * - `apify` (opção): Google Places via Apify, com a chave da PRÓPRIA
 *   organização. Paga por uso, traz telefone, nota e avaliações.
 *
 * As duas desembocam no mesmo `Prospect` (`lib/prospecting/schema.ts`): é
 * ele que o worker consome ao montar a abordagem. Fonte nova entra aqui
 * produzindo `Prospect`, sem tocar no resto do funil.
 */
export type FonteDeBusca = "osm" | "apify";

export const FONTES_DE_BUSCA: readonly FonteDeBusca[] = ["osm", "apify"] as const;

export function ehFonteGratuita(fonte: FonteDeBusca): boolean {
  return fonte === "osm";
}

export function rotuloDaFonte(fonte: FonteDeBusca): string {
  return fonte === "osm" ? "Gratuita (OpenStreetMap)" : "Apify (Google Maps)";
}
