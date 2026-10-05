import type { LeadFilters } from "@/lib/kanban/filters";
import { marcadoresDoFiltro } from "@/lib/kanban/filters";

/**
 * Quais filtros do quadro estão ligados, em palavras que o operador reconhece.
 *
 * Espelha `lib/inbox/filtros-ativos.ts`: a lista lê do MESMO objeto que foi ao
 * `applyFilters`, então a tela nunca nomeia um
 * filtro que a consulta não aplicou — nem cala um que aplicou.
 *
 * Cobre exatamente os campos reais de `LeadFilters`. `unreadOnly`/`channel`/
 * datas NÃO existem nesse tipo — o helper não os inventa.
 *
 * As strings saem em português porque `t()` usa o português como chave; cada
 * uma precisa existir em `lib/i18n/dicionario.ts` (o guardião do espanhol é
 * cego a `t(<variável>)`).
 */
export function filtrosAtivosDoKanban(filters: LeadFilters): string[] {
  const ativos: string[] = [];
  const etiquetas = marcadoresDoFiltro(filters.tag);
  if (filters.owner && filters.owner !== "any") ativos.push("Responsável");
  if (filters.status && filters.status !== "all") ativos.push("Status");
  if (etiquetas.length > 0) {
    ativos.push("Etiqueta");
    if (etiquetas.length > 1 && filters.tagMode === "ou") ativos.push("Modo: OU");
  }
  if (filters.search?.trim()) ativos.push("Busca");
  if (typeof filters.valueCentsMin === "number") ativos.push("Valor mínimo");
  if (typeof filters.valueCentsMax === "number") ativos.push("Valor máximo");
  if (filters.overdueOnly) ativos.push("Apenas atrasados");
  if (filters.lostReason) ativos.push("Motivo de perda");
  if (filters.lostCategory) ativos.push("Categoria");
  return ativos;
}
