/**
 * AS CONSULTAS DA FILA — só leitura, e cada uma responde uma pergunta que a
 * tela ou o worker precisa fazer.
 *
 * Todas usam `service role` e por isso filtram `organization_id` na mão, em
 * TODA consulta: `lib/supabase/admin.ts` bypassa RLS, e RLS não é o que segura
 * o isolamento aqui. O `organizationId` vem do cookie (ou do guard), nunca do
 * corpo da requisição.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerRitmoEnvio, type RitmoEnvio } from "./config";
import { classificarEnvio, type TipoDeEnvio } from "./classificacao";
import { contarAbordagensDeHoje } from "./limite-diario";

/**
 * Colunas da fila em que a tela e o worker precisam.
 *
 * `claim_token` e `dispatch_started_at` entram na lista por um motivo concreto:
 * são eles que dizem à tela se o item já começou a ir para o provedor. Sem as
 * duas, a bolha mostraria "na fila" para uma mensagem que na verdade já foi
 * despachada — e o botão "editar" apareceria para algo que não pode mais ser
 * editado. Declaradas em `LinhaDaFila` sem vir no SELECT é a forma silenciosa de
 * isso acontecer.
 */
export const COLUNAS_DA_FILA =
  "id, organization_id, message_id, contact_id, conversation_id, channel_session_id, tipo, status, prioridade, scheduled_at, tentativas, max_tentativas, claim_token, snapshot_body, snapshot_tipo, intervalo_s, forcar_envio, dispatch_started_at, enviado_em, pausado_em, pausado_motivo, cancelado_em, falho_em, erro, editada_em, criado_em, criado_por_user_id, atualizado_em";

/**
 * As mesmas colunas que `listMessagesHandler` devolve (a lista viva está em
 * `MSG_COLS`, `app/api/v1/messages/_handler.ts`). Espelha aqui porque o inbox, o
 * MCP, o histórico do atendimento e a exportação de LGPD leem essa lista — e
 * devolver MENOS colunas para a mensagem enfileirada faria a bolha perder
 * campos que as outras têm.
 */
export const COLUNAS_DA_MENSAGEM =
  "id, organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, ack, error_code, error_message, body, media_url, media_mime, media_size_bytes, media_storage_path, media_derived_text, media_derived_status, sent_via, sent_by_user_id, sent_on_behalf_of_user_id, sent_at, delivered_at, read_at, metadata, edited_at, revoked_at, reply_to_message_id, created_at";

/**
 * A fila vista pela tela.
 *
 * É uma visão mais APERTADA que a Row de `database.types.ts` em três pontos
 * deliberados, e nenhum deles é esquecimento: `tipo` vira união (o banco guarda
 * texto e o `check` é quem garante o domínio), e os campos de envio são
 * opcionais porque nem toda projeção os traz — `lerItemDaFila` devolve a lista
 * completa, mas a mensagem enfileirada vem de outra consulta. Todo campo que a
 * tela usa para DECIDIR (se já despachou, se o texto é o original) é
 * obrigatório no select, e a ausência é `undefined`, não `null`.
 */
export interface LinhaDaFila {
  id: string;
  organization_id: string;
  message_id: string;
  contact_id: string;
  conversation_id: string;
  channel_session_id: string;
  tipo: TipoDeEnvio;
  status: "pending" | "processing" | "sent" | "paused" | "cancelled" | "failed";
  prioridade: number;
  scheduled_at: string;
  tentativas: number;
  max_tentativas: number;
  claim_token?: string | null;
  snapshot_body?: string | null;
  snapshot_tipo?: string | null;
  intervalo_s?: number;
  forcar_envio?: boolean;
  dispatch_started_at?: string | null;
  enviado_em: string | null;
  pausado_em: string | null;
  pausado_motivo: string | null;
  cancelado_em: string | null;
  falho_em: string | null;
  erro: string | null;
  editada_em: string | null;
  criado_em: string;
}

/**
 * A configuração do ritmo, lida do `organizations.settings`.
 *
 * `maybeSingle` + fallback: organização sem `settings` (instalação nova) não é
 * erro, é o estado antes de alguém configurar. A página de Configurações
 * mostra o default e salva por cima.
 */
export async function lerRitmoDoTenant(
  admin: SupabaseClient,
  organizationId: string,
): Promise<RitmoEnvio> {
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`settings_indisponivel: ${error.message}`);
  return lerRitmoEnvio(data?.settings);
}

/**
 * O FIM DA CADEIA: o maior entre o último envio para OUTRO contato e o maior
 * horário já ocupado na fila.
 *
 * ── Por que o filtro `neq("contact_id", ...)` é o mais importante do arquivo ──
 *
 * É ele que faz três mensagens seguidas para a MESMA pessoa não custarem
 * minutos cada. Sem ele, responder a alguém que mandou mensagem agora há 10
 * segundos esperaria 90–180s — que é o oposto de uma conversa.
 *
 * `direction` filtra só o que SAIU. `messages.status` já vale `queued` desde o
 * clique (a linha nasce antes do envio), então filtrar por status aqui
 * transformaria o próprio item pendente em "último envio" e a fila nunca
 * destravaria.
 */
export async function fimDaCadeia(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<Date | null> {
  const { data: ultimoEnvio, error: erroEnvio } = await admin
    .from("messages")
    .select("sent_at")
    .eq("organization_id", organizationId)
    .eq("direction", "outbound")
    .neq("contact_id", contactId)
    .in("status", ["sent", "delivered", "read"])
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (erroEnvio) throw new Error(`ultimo_envio_indisponivel: ${erroEnvio.message}`);

  const { data: cauda, error: erroCauda } = await admin
    .from("message_send_queue")
    .select("scheduled_at")
    .eq("organization_id", organizationId)
    .in("status", ["pending", "paused"])
    .neq("contact_id", contactId)
    .order("scheduled_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (erroCauda) throw new Error(`cauda_da_fila_indisponivel: ${erroCauda.message}`);

  const candidatos = [ultimoEnvio?.sent_at, cauda?.scheduled_at]
    .filter((v): v is string => Boolean(v))
    .map((v) => new Date(v).getTime())
    .filter((ms) => !Number.isNaN(ms));

  return candidatos.length ? new Date(Math.max(...candidatos)) : null;
}

/**
 * O retrato do CRM para a inferência de tipo.
 *
 * As três primeiras colunas são a conversa como a tela a conhece; a quarta
 * (`tem_follow_up_marcado`) é um `exists` porque `followup_enrollments` tem
 * linha por contato e não vale carregar.
 */
export async function retratoDaConversa(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
  contactId: string,
  agora: Date,
): Promise<TipoDeEnvio> {
  const { data: conversa, error } = await admin
    .from("conversations")
    .select("contact_id, last_inbound_at, last_outbound_at, awaiting_since")
    .eq("organization_id", organizationId)
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error(`conversa_indisponivel: ${error.message}`);

  const { data: followup } = await admin
    .from("followup_enrollments")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("status", ["active", "waiting_reply"])
    .limit(1)
    .maybeSingle();

  return classificarEnvio(
    {
      contactId,
      lastInboundAt: conversa?.last_inbound_at ?? null,
      lastOutboundAt: conversa?.last_outbound_at ?? null,
      awaitingSince: conversa?.awaiting_since ?? null,
      temFollowUpMarcado: Boolean(followup?.id),
    },
    agora,
  );
}

/** Tipo inferido, exposto com o nome certo. (Wrapper fino: nome legível na rota.) */
export async function inferirTipoDeEnvio(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
  contactId: string,
  agora: Date,
): Promise<TipoDeEnvio> {
  return retratoDaConversa(admin, organizationId, conversationId, contactId, agora);
}

/**
 * Quantas novas abordagens já estão vivas hoje. Alimenta o teto diário.
 *
 * `gte("criado_em", inicioDoDia)` é o filtro: uma abordagem que ficou na fila
 * de ontem não consome o orçamento de hoje, e uma que hoje entrou consome.
 */
export async function abordagensVivasHoje(
  admin: SupabaseClient,
  organizationId: string,
  agora: Date,
): Promise<number> {
  const { data: org } = await admin
    .from("organizations")
    .select("timezone")
    .eq("id", organizationId)
    .maybeSingle();
  const tz = (org as { timezone?: string | null } | null)?.timezone ?? "UTC";
  const inicioDoDia = inicioDoDiaNoFuso(agora, tz);

  const { data, error } = await admin
    .from("message_send_queue")
    .select("tipo, status, enviado_em, criado_em")
    .eq("organization_id", organizationId)
    .gte("criado_em", inicioDoDia.toISOString());
  if (error) throw new Error(`abordagens_indisponiveis: ${error.message}`);
  const daFila = contarAbordagensDeHoje(
    ((data ?? []) as { tipo: TipoDeEnvio; status: string; enviado_em: string | null; criado_em: string }[]).map(
      (linha) => ({
        tipo: linha.tipo,
        status: linha.status,
        enviadoEm: linha.enviado_em,
        criadoEm: linha.criado_em,
      }),
    ),
    agora.toISOString(),
  );

  // Envios imediatos de hoje também consomem o teto: uma prospecção que saiu
  // direto (fila desligada na hora, ou resposta prioritária) não pode furar o
  // limite do dia. O tipo viaja em `messages.metadata.tipo_envio`.
  const { data: imediatas, error: erroImediatas } = await admin
    .from("messages")
    .select("id, sent_at, metadata")
    .eq("organization_id", organizationId)
    .eq("direction", "outbound")
    .in("status", ["sent", "delivered", "read"])
    .gte("sent_at", inicioDoDia.toISOString());
  if (erroImediatas) throw new Error(`abordagens_imediatas_indisponiveis: ${erroImediatas.message}`);
  const daFilaIds = new Set((data ?? []).map((l) => (l as { id?: string }).id).filter(Boolean));
  const imediatasProspeccao = (imediatas ?? []).filter((m) => {
    const meta = (m as { metadata?: Record<string, unknown> | null }).metadata;
    return meta && meta["tipo_envio"] === "prospeccao";
  });
  // Evita contar em dobro: itens da fila já estão em `daFila`.
  const { data: filaIds } = await admin
    .from("message_send_queue")
    .select("message_id")
    .eq("organization_id", organizationId);
  const idsNaFila = new Set((filaIds ?? []).map((r) => (r as { message_id: string }).message_id));
  const imediatasForaDaFila = imediatasProspeccao.filter((m) => !idsNaFila.has((m as { id: string }).id));

  return daFila + imediatasForaDaFila.length;
}

/** Meia-noite no fuso da organização, devolvida como instante UTC. */
export function inicioDoDiaNoFuso(agora: Date, tz: string): Date {
  try {
    const partes = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(agora);
    const get = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
    const meiaNoiteLocalComoUtc = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")));
    // Offset do fuso naquele instante: a diferença entre o relógio local e o UTC.
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p2 = dtf.formatToParts(new Date(meiaNoiteLocalComoUtc));
    const g = (t: string) => p2.find((p) => p.type === t)?.value ?? "0";
    const localComoUtc = Date.UTC(Number(g("year")), Number(g("month")) - 1, Number(g("day")), Number(g("hour")) % 24, Number(g("minute")), Number(g("second")));
    const offset = localComoUtc - meiaNoiteLocalComoUtc;
    return new Date(meiaNoiteLocalComoUtc - offset);
  } catch {
    return inicioDoDiaUtc(agora);
  }
}

/** Meia-noite UTC do dia corrente. O fuso da organização entra na exibição, não no corte. */
export function inicioDoDiaUtc(agora: Date): Date {
  return new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
}

/** Quantas mensagens estão aguardando — o badge "Fila de envio: N". */
export async function contarAguardando(admin: SupabaseClient, organizationId: string): Promise<number> {
  const { count, error } = await admin
    .from("message_send_queue")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("status", ["pending", "processing"]);
  if (error) throw new Error(`contagem_da_fila_indisponivel: ${error.message}`);
  return count ?? 0;
}

/** A fila inteira na ordem prevista de envio, para o painel. */
export async function listarFila(
  admin: SupabaseClient,
  organizationId: string,
  limite = 50,
): Promise<LinhaDaFila[]> {
  const { data, error } = await admin
    .from("message_send_queue")
    .select(`${COLUNAS_DA_FILA},mensagem:message_id(body),contato:contact_id(name,display_name)`)
    .eq("organization_id", organizationId)
    .in("status", ["pending", "processing", "paused"])
    .order("prioridade", { ascending: true })
    .order("scheduled_at", { ascending: true })
    .limit(limite);
  if (error) throw new Error(`fila_indisponivel: ${error.message}`);
  return (data ?? []).map((row) => {
    const contact = row.contato as unknown as { name?: string; display_name?: string } | null;
    return { ...row, contato: { nome: contact?.display_name ?? contact?.name ?? "Contato" } };
  }) as unknown as LinhaDaFila[];
}

/** Uma linha, filtrada por organização. `null` = não existe ou é de outra empresa. */
export async function lerItemDaFila(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<LinhaDaFila | null> {
  const { data, error } = await admin
    .from("message_send_queue")
    .select(COLUNAS_DA_FILA)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`item_da_fila_indisponivel: ${error.message}`);
  return (data as LinhaDaFila | null) ?? null;
}
