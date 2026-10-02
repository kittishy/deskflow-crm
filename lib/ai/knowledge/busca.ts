/**
 * Busca na base de conhecimento da organizacao — operacao unica, compartilhada.
 *
 * Existe porque a mesma pergunta ("o que a empresa ja sabe sobre isto?") passou
 * a ter dois chamadores: o turno do agente e a capacidade MCP que o humano liga
 * na tela. Duas implementacoes divergiriam em limiar, em top-K e em como tratam
 * "a base nao tem essa informacao" — e o sistema passaria a responder diferente
 * para a IA e para o humano sobre o MESMO acervo. Organizações free-only usam
 * busca textual autenticada, sem embeddings nem limiar vetorial.
 *
 * Desde a 0181 o motor e a RPC `fn_buscar_trechos_das_fontes`, que recebe a
 * LISTA de materiais que o agente pode ler. Ela e SECURITY DEFINER e filtra por
 * organizacao dentro do banco; o contrato exige que quem chama valide o tenant,
 * e aqui `organizationId` SEMPRE vem de fonte confiavel (token/cookie), nunca do
 * corpo da requisicao.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { embedText } from "@/lib/ai/embed";
import { freeOnlyForOrganization } from "@/lib/ai/free-only";

/**
 * Limiar vetorial do CAMINHO DO HUMANO — o mesmo que a ferramenta MCP `crm_search_knowledge`
 * usa. Mora aqui, e não em `lib/mcp/tools/evolucao.ts`, por um motivo prático: a
 * operação é única, e uma constante duplicada é o primeiro passo para a busca do
 * operador e a da IA divergirem sobre o mesmo acervo.
 *
 * É o MESMO default do banco desde a migration 0097. Era 0.72 na ferramenta MCP,
 * e o produto tinha TRÊS limiares para o mesmo acervo: 0.40 na RPC, 0.72 no turno
 * do agente e 0.72 nesta capacidade. Duas pessoas perguntando a mesma coisa pelo
 * mesmo material recebiam respostas diferentes conforme a porta por onde entraram.
 *
 * O turno do agente lê `ai_agents.config.rag_similarity_threshold`, cujo padrão
 * também é 0,40 (`agent-config.ts`, `guardrails-schema.ts`). Quem pergunta na tela
 * pode escopar por agente e herdar o limiar dele — é o caminho que devolve a MESMA
 * resposta que a IA daria.
 */
export const LIMIAR_PADRAO_BUSCA = 0.4;

/**
 * Vocabulário de `knowledge_searches.author_kind` (CHECK da 0484, par vigiado em
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`).
 */
export const KNOWLEDGE_SEARCH_AUTHOR_KINDS = ["human", "ai"] as const;

export interface TrechoEncontrado {
  chunk_id: string;
  knowledge_source_id: string | null;
  /** Nome do material de onde o trecho saiu — a resposta cita a origem. */
  source_name?: string | null;
  content: string;
  similarity: number;
}

export interface ResultadoDaBusca {
  /** Trechos ordenados pela métrica indicada em `modo`. */
  trechos: TrechoEncontrado[];
  /**
   * Melhor pontuação: similaridade vetorial no modo vetorial ou rank lexical no
   * modo textual. `modo` identifica qual métrica está sendo devolvida.
   *
   * Sem este numero, "a base nao tem essa informacao" e "a base tem algo perto,
   * mas nao o bastante" chegam iguais a quem pergunta — e sao situacoes que
   * pedem acoes opostas: uma manda buscar com humano, a outra manda reformular.
   */
  melhorSimilaridade: number | null;
  modo?: "vetorial" | "textual";
}

export interface ParametrosDaBusca {
  organizationId: string;
  /** Materiais que quem pergunta pode ler. */
  knowledgeSourceIds: string[];
  pergunta: string;
  topK: number;
  limiar: number;
}

interface LinhaDaRpc {
  chunk_id: string;
  knowledge_source_id: string | null;
  source_name: string | null;
  content: string;
  similarity: number;
}

export async function buscarConhecimento(
  supabase: SupabaseClient,
  p: ParametrosDaBusca,
  deps?: { embed?: typeof embedText },
): Promise<ResultadoDaBusca> {
  if (p.knowledgeSourceIds.length === 0) {
    return { trechos: [], melhorSimilaridade: null, modo: freeOnlyForOrganization(p.organizationId) ? "textual" : "vetorial" };
  }

  if (freeOnlyForOrganization(p.organizationId)) {
    const { data, error } = await supabase.rpc("fn_buscar_trechos_textuais_das_fontes", {
      p_organization_id: p.organizationId,
      p_source_ids: p.knowledgeSourceIds,
      p_query: p.pergunta,
      p_k: p.topK,
    });
    if (error) throw new Error(`busca_textual_de_conhecimento_falhou: ${error.message}`);
    const linhas = (data ?? []) as LinhaDaRpc[];
    return {
      modo: "textual",
      trechos: linhas.map((l) => ({
        chunk_id: l.chunk_id,
        knowledge_source_id: l.knowledge_source_id,
        source_name: l.source_name,
        content: l.content,
        similarity: l.similarity,
      })),
      melhorSimilaridade: linhas.length > 0 ? Math.max(...linhas.map((l) => l.similarity)) : null,
    };
  }

  const embed = deps?.embed ?? embedText;
  // `model` é o que calculou ESTA pergunta; a busca só compara com trechos do
  // mesmo modelo — trocar de provedor não mistura vetores de mapas diferentes.
  const { embedding, model } = await embed(p.pergunta, {
    organizationId: p.organizationId,
    ponto: "embedding_consultar",
  });

  // Piso real da similaridade de cosseno (1 - distancia, distancia em [0,2]).
  // Pedimos SEM limiar e cortamos aqui para conseguir enxergar o melhor
  // candidato reprovado — a RPC sozinha devolveria uma lista vazia sem dizer
  // se faltou pouco ou se nao ha nada parecido no acervo.
  const PISO = -1;

  const { data, error } = await supabase.rpc("fn_buscar_trechos_das_fontes", {
    p_organization_id: p.organizationId,
    p_source_ids: p.knowledgeSourceIds,
    p_embedding: `[${embedding.join(",")}]`,
    p_k: p.topK,
    p_threshold: PISO,
    p_embedding_model: model,
  });

  if (error) {
    throw new Error(`busca_de_conhecimento_falhou: ${error.message}`);
  }

  const linhas = (data ?? []) as LinhaDaRpc[];
  const melhor = linhas.length > 0 ? Math.max(...linhas.map((l) => l.similarity)) : null;

  return {
    modo: "vetorial",
    trechos: linhas
      .filter((l) => l.similarity >= p.limiar)
      .map((l) => ({
        chunk_id: l.chunk_id,
        knowledge_source_id: l.knowledge_source_id,
        source_name: l.source_name,
        content: l.content,
        similarity: l.similarity,
      })),
    melhorSimilaridade: melhor,
  };
}

/**
 * Resolve QUAIS materiais o agente pode consultar.
 *
 * Ate a 0181 isto era um ponteiro escalar na tabela do agente
 * (`active_kb_version_id`). Agora e a escolha da VERSAO PUBLICADA
 * (`ai_agent_versions.knowledge_source_ids`) — dois agentes da mesma empresa
 * podem ler acervos diferentes, e o mesmo manual pode servir aos dois sem ser
 * cadastrado duas vezes.
 *
 * Quando o agente nao tem versao publicada com materiais, cai no ponteiro
 * legado: o clone que ainda nao aplicou a migration continua respondendo com o
 * acervo antigo em vez de emudecer.
 */
export async function resolverAcervoDoAgente(
  supabase: SupabaseClient,
  organizationId: string,
  agentId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("ai_agents")
    .select("active_kb_version_id, published_version_id")
    .eq("id", agentId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) throw new Error(`acervo_do_agente_falhou: ${error.message}`);
  if (!data) return [];

  const publishedVersionId = (data as { published_version_id: string | null }).published_version_id;
  if (publishedVersionId) {
    const { data: versao } = await supabase
      .from("ai_agent_versions")
      .select("knowledge_source_ids")
      .eq("id", publishedVersionId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    const fontes = (versao as { knowledge_source_ids: string[] | null } | null)
      ?.knowledge_source_ids;
    if (fontes && fontes.length > 0) return fontes;
  }

  // Reserva legada: os materiais que ainda apontam para a versao ativa do agente.
  const kbVersionId = (data as { active_kb_version_id: string | null }).active_kb_version_id;
  if (!kbVersionId) return [];

  const { data: fontesLegadas } = await supabase
    .from("ai_knowledge_sources")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("active_kb_version_id", kbVersionId)
    .eq("is_active", true);

  return ((fontesLegadas ?? []) as Array<{ id: string }>).map((f) => f.id);
}
