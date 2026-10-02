import { z } from "zod";
import type { SearchInput } from "../schema";
import { ProspectingError } from "../provider";

/**
 * FONTE PAGA — Apify (Google Places), com a chave da PRÓPRIA organização.
 *
 * Este arquivo é o adapter Apify que morava em `lib/prospecting/provider.ts`,
 * movido para cá sem mudar uma linha de comportamento quando a fonte gratuita
 * (OSM) entrou como padrão. Quem importa de `../provider` continua
 * funcionando: ele reexporta tudo daqui.
 *
 * Custa saldo da Apify (US$0,50–10 por busca, conforme docs/features) e exige
 * a chave cadastrada em Prospecção → Configurar busca (cifrada por
 * organization_id). Sem chave, sem busca paga — a gratuita não pede nada.
 */
const runSchema = z.object({
  data: z.object({
    id: z.string(),
    status: z.string(),
    defaultDatasetId: z.string().optional(),
    usageTotalUsd: z.number().optional(),
  }),
});
const ACTOR = "compass~crawler-google-places";
/** Provider adapter: same Actor and normalization contract as the existing Maps workflows. */
export async function providerRequest(key: string, path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.apify.com/v2/${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new ProspectingError(
      "O provedor não confirmou a operação. Consulte o histórico antes de repetir uma busca.",
      502,
    );
  }
  if (!response.ok)
    throw new ProspectingError(
      response.status === 401
        ? "Chave de busca inválida."
        : response.status === 402
          ? "Saldo ou limite de uso insuficiente no provedor de busca."
          : `Busca indisponível (HTTP ${response.status}).`,
      502,
    );
  return response.json();
}
export async function startSearch(key: string, input: SearchInput) {
  // No retries on POST: an ambiguous timeout must never start another paid run.
  return runSchema.parse(
    await providerRequest(
      key,
      `acts/${ACTOR}/runs?maxItems=${input.limit}&maxTotalChargeUsd=${input.budget_usd}&timeout=300`,
      {
        searchStringsArray: [input.niche],
        locationQuery: input.location,
        maxCrawledPlacesPerSearch: input.limit,
        language: "pt-BR",
        countryCode: "br",
        skipClosedPlaces: true,
        scrapeContacts: input.enrich,
        maxReviews: 0,
        maxImages: 0,
        maximumLeadsEnrichmentRecords: 0,
      },
    ),
  ).data;
}
export async function readSearch(key: string, id: string) {
  return runSchema.parse(await providerRequest(key, `actor-runs/${encodeURIComponent(id)}`)).data;
}
export async function readResults(key: string, dataset: string, limit: number) {
  return z
    .array(z.record(z.string(), z.unknown()))
    .max(100)
    .parse(
      await providerRequest(
        key,
        `datasets/${encodeURIComponent(dataset)}/items?clean=true&limit=${limit}`,
      ),
    );
}
export { ProspectingError };
