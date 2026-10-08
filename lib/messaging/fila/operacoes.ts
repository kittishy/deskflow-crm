import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { Message } from "@/lib/types/messaging";
import { audit } from "@/lib/audit";
import { PRIORIDADE } from "./classificacao";
import { COLUNAS_DA_MENSAGEM, inferirTipoDeEnvio, lerRitmoDoTenant, type LinhaDaFila } from "./consultas";

/** Admission takes an already validated, already persisted message identity. */
export async function admitirMensagem(
  admin: SupabaseClient,
  ctx: HandlerCtx,
  message: Message,
): Promise<LinhaDaFila | null> {
  if (!ctx.filaEnvio || ctx.actor.type !== "user" || message.type !== "text") return null;
  const config = await lerRitmoDoTenant(admin, ctx.organization_id);
  if (!config.ativo) return null;
  const tipo = ctx.filaEnvio.tipoEscolhido ?? await inferirTipoDeEnvio(
    admin, ctx.organization_id, message.conversation_id, message.contact_id!, new Date(),
  );
  const { data, error } = await admin.rpc("fn_fila_envio_admitir", {
    p_organization_id: ctx.organization_id,
    p_message_id: message.id,
    p_contact_id: message.contact_id,
    p_conversation_id: message.conversation_id,
    p_channel_session_id: message.channel_session_id,
    p_tipo: tipo,
    p_prioridade: PRIORIDADE[tipo],
    p_agora: new Date().toISOString(),
    p_intervalo_minimo_s: config.intervalo_minimo_s,
    p_intervalo_maximo_s: config.intervalo_maximo_s,
    p_limite_diario: config.limite_diario_prospeccoes,
    p_criado_por_user_id: ctx.actor.id,
  });
  if (error || !data) throw new Error("queue_admission_unavailable");
  const item = (Array.isArray(data) ? data[0] : data) as LinhaDaFila;
  if (!item?.id) throw new Error("queue_admission_unavailable");
  await audit({
    action: item.status === "paused" ? "message.queue_blocked" : "message.queued",
    actorUserId: ctx.actor.id,
    organizationId: ctx.organization_id,
    resourceType: "message_send_queue",
    resourceId: item.id,
    requestId: ctx.requestId,
    metadata: { message_id: message.id, tipo, scheduled_at: item.scheduled_at },
  });
  return item;
}

export async function lerMensagemEnfileirada(admin: SupabaseClient, organizationId: string, messageId: string) {
  const { data, error } = await admin.from("messages").select(COLUNAS_DA_MENSAGEM)
    .eq("organization_id", organizationId).eq("id", messageId).maybeSingle();
  if (error) throw new Error("queue_message_unavailable");
  return data as unknown as Message | null;
}

async function alterar(admin: SupabaseClient, org: string, id: string, acao: string, corpo?: string): Promise<boolean> {
  const { data, error } = await admin.rpc("fn_fila_envio_alterar", {
    p_org: org, p_id: id, p_acao: acao, p_corpo: corpo ?? null,
  });
  if (error) throw new Error("queue_action_unavailable");
  return data === true;
}

export const cancelar = (admin: SupabaseClient, org: string, id: string) => alterar(admin, org, id, "cancelar");
export const pausar = (admin: SupabaseClient, org: string, id: string) => alterar(admin, org, id, "pausar");
export const retomar = (admin: SupabaseClient, org: string, id: string) => alterar(admin, org, id, "retomar");
export const editar = (admin: SupabaseClient, org: string, id: string, corpo: string) => alterar(admin, org, id, "editar", corpo);
export const agendarParaAgora = (admin: SupabaseClient, org: string, id: string) => alterar(admin, org, id, "enviar_agora");

export async function autorizarDispatch(admin: SupabaseClient, org: string, id: string, token: string): Promise<void> {
  const { data, error } = await admin.rpc("fn_fila_envio_autorizar", { p_org: org, p_id: id, p_token: token });
  if (error || data !== true) throw new Error("queue_dispatch_revoked");
}
