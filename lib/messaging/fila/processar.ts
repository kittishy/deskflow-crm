/**
 * O WORKER DA FILA — reivindica, envia, e fecha o item.
 *
 * ## O caminho, e por que cada degrau existe
 *
 *     pending → fn_fila_envio_reivindicar → processing → sent | failed
 *
 * ─── Degrau 1: a reivindicação é uma FUNÇÃO DO BANCO ─────────────────────────
 *
 * Não há advisory lock aqui, e isso é uma decisão, não uma falta. O PostgREST
 * não oferece `pg_advisory_lock` (é a mesma limitação que
 * `lib/messaging/ritmo-do-envio-por-token.ts` registra sobre o `pacing_ledger`),
 * e nem sabe fazer `tentativas = tentativas + 1` num update filtrado — o
 * PostgREST grava valor literal. Um `select` e depois um `update` seria corrida.
 *
 * A função `fn_fila_envio_reivindicar` faz as duas coisas numa transação só:
 * `for update skip locked` (cada worker pega o próximo item LIVRE) e o
 * incremento de tentativas. Ou o worker recebe o item já `processing`, ou não
 * recebe nada. Duas instâncias, um envio.
 *
 * Remote acceptance and local persistence are not one transaction. A timeout
 * or interrupted attempt is therefore failed visibly, never replayed blindly.
 * send_ledger belongs to job_queue and cannot reference this queue's IDs.
 *
 * ─── Reinício do servidor ───────────────────────────────────────────────────
 *
 * Nada é mantido em memória. A fila é a tabela, e `processing` com `locked_at`
 * velho is marked failed for reconciliation, not reset to pending.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { ehOperante } from "@/lib/organizacao/operante";
import { roleAtLeast } from "@/lib/auth/types";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";

import { COLUNAS_DA_FILA, type LinhaDaFila } from "./consultas";

/** Identifica a instância no log quando algo trava. */
const WORKER_ID = `fila-de-envio:${randomUUID()}`;

/**
 * Recusas que o canal DECLAROU — o pedido terminou, nada foi entregue, e
 * repetir não duplica nada.
 *
 * Todos estes nomes vêm do vocabulário real dos adapters
 * (`lib/channels/adapters/*.ts` → `codes.*`) e das exceções que eles lançam,
 * não de invenção: `recipient_unavailable` e `missing_phone_number` são
 * "não há para quem enviar"; `channel_archived`/`channel_disabled` são sessão
 * ou canal fora de uso — e quem os conserta é a pessoa, não a fila, por isso
 * aqui valem como esgotamento quando as tentativas acabam.
 *
 * O que NÃO está nesta lista é o ponto: o código genérico de falha que o adapter
 * lança quando não tem certeza, timeout, 502 e qualquer falha de rede são
 * resultado INCERTO. A mensagem pode ter saído. Ver a seção de
 * anti-banimento da doutrina para por que reenviar no escuro não é aceitável.
 */
const RECUSAS_CONHECIDAS = new Set([
  "recipient_unavailable",
  "missing_phone_number",
  "channel_archived",
  "channel_disabled",
  "contact_payload_missing",
  "pre_go_live",
  "pre_go_live_indisponivel",
]);

/**
 * Qual código descrever o desfecho, quando o `sendMessageHandler` devolveu uma
 * mensagem já marcada `failed` em vez de lançar.
 *
 * O handler persiste `error_code` na própria linha antes de devolver, e é esse
 * campo que sabe se o canal recusou — a exceção, quando existe, é sempre a
 * versão genérica do adapter, que é justamente a categoria incerta. Por isso o
 * `error_code` tem precedência.
 */
function codigoDoDesfecho(
  erro: unknown,
  desfecho: { error_code?: string | null } | null,
): string {
  if (desfecho?.error_code) return desfecho.error_code;
  if (erro instanceof Error && erro.message) return erro.message;
  return "delivery_not_confirmed";
}

/** Depois disso, um `processing` sem movimento é resíduo de worker morto. */
export const TRAVADO_HA_MS = 5 * 60 * 1000;

/** Espera entre itens na MESMA rodada: a régua de intervalo já está em `scheduled_at`. */
const PAUSA_ENTRE_ITENS_MS = 0;

export interface ResultadoDaRodada {
  enviados: number;
  reagendados: number;
  esgotados: number;
  /** Itens que o worker não pode mais tocar (enviado, cancelado, esgotado). */
  ignorados: number;
}

export interface DepsDoWorker {
  admin: SupabaseClient;
  agora(): Date;
  sleep?(ms: number): Promise<void>;
}

/**
 * Reconcilia itens presos em `processing`.
 *
 * `locked_at` velho é a assinatura de um worker que morreu com o item na mão —
 * inclusive a restart during delivery. The remote outcome is unknown, so the
 * item requires reconciliation before any new attempt.
 */
export async function recuperarTravados(admin: SupabaseClient, agora: Date): Promise<number> {
  const corte = new Date(agora.getTime() - TRAVADO_HA_MS).toISOString();
  const { data, error } = await admin
    .from("message_send_queue")
    .update({
      status: "failed",
      erro: "delivery_outcome_unknown",
      falho_em: agora.toISOString(),
      locked_by: null,
      locked_at: null,
      atualizado_em: agora.toISOString(),
    })
    .eq("status", "processing")
    .lt("locked_at", corte)
    .select("id");
  if (error) throw new Error(`recuperacao_falhou: ${error.message}`);
  const quantidade = (data ?? []).length;
  if (quantidade) {
    logger.warn("[fila.envio] tentativas interrompidas exigem reconciliacao", { quantidade, locked_ate: corte });
  }
  return quantidade;
}

/** A reivindicação. Função do banco; ver a nota de `skip locked` no topo. */
export async function reivindicar(admin: SupabaseClient, agora: Date): Promise<LinhaDaFila | null> {
  const { data, error } = await admin.rpc("fn_fila_envio_reivindicar", {
    p_worker: WORKER_ID,
    p_agora: agora.toISOString(),
  });
  if (error) throw new Error(`reivindicacao_falhou: ${error.message}`);
  const linha = (Array.isArray(data) ? data[0] : data) as LinhaDaFila | null;
  if (!linha) return null;
  return { ...linha, tentativas: Number(linha.tentativas ?? 0) };
}

/** Fecha o item como enviado. `where status='processing'` — só o dono fecha. */
async function concluirEnviado(
  admin: SupabaseClient,
  item: LinhaDaFila,
  enviadoEm: string,
): Promise<void> {
  const { error } = await admin
    .from("message_send_queue")
    .update({
      status: "sent",
      enviado_em: enviadoEm,
      atualizado_em: enviadoEm,
      locked_by: null,
      locked_at: null,
      erro: null,
    })
    .eq("organization_id", item.organization_id)
    .eq("id", item.id)
    .eq("status", "processing")
    .eq("claim_token", item.claim_token!)
    .eq("locked_by", WORKER_ID);
  if (error) throw new Error(`fechamento_falhou: ${error.message}`);
}

/**
 * Processa UM item. Separate da rodada para que o teste possa exercitar o
 * caminho de falha sem cron nem banco de verdade.
 */
export async function processarItem(admin: SupabaseClient, item: LinhaDaFila): Promise<"sent" | "retry" | "failed" | "ignored"> {
  const { data: organization, error: organizationError } = await admin
    .from("organizations")
    .select("status")
    .eq("id", item.organization_id)
    .maybeSingle();
  if (organizationError) throw new Error("queue_organization_unavailable");
  if (!ehOperante(organization?.status)) return "ignored";
  const { data: mensagem, error: erroLeitura } = await admin
    .from("messages")
    .select("id, conversation_id, channel_session_id, contact_id, body, type, metadata")
    .eq("organization_id", item.organization_id)
    .eq("id", item.message_id)
    .maybeSingle();
  if (erroLeitura) throw new Error(`mensagem_da_fila_indisponivel: ${erroLeitura.message}`);

  // A mensagem sumiu (LGPD, moderação, exclusão em cascata). `cascade` já teria
  // levado o item junto; este é o resto dos casos.
  if (!mensagem) {
    await admin
      .from("message_send_queue")
      .update({ status: "cancelled", cancelado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() })
      .eq("id", item.id)
      .eq("status", "processing");
    return "ignored";
  }

  // Cancelado ou pausado ENTRE a reivindicação e agora: o operador ganhou.
  const atual = await admin
    .from("message_send_queue")
    .select("status")
    .eq("id", item.id)
    .eq("organization_id", item.organization_id)
    .maybeSingle();
  if (!atual?.data || (atual.data as { status: string }).status !== "processing") return "ignored";

  const corpo = item.snapshot_body ?? (mensagem as { body: string | null }).body ?? "";
  if (!corpo.trim()) {
    await admin
      .from("message_send_queue")
      .update({
        status: "failed",
        falho_em: new Date().toISOString(),
        erro: "conteudo_vazio",
        atualizado_em: new Date().toISOString(),
        locked_by: null,
        locked_at: null,
      })
      .eq("id", item.id)
      .eq("status", "processing");
    return "failed";
  }

  // Declarado aqui (e não dentro do try) porque o `catch` precisa do desfecho
  // para distinguir recusa conhecida de resultado incerto.
  let desfecho: { error_code?: string | null } | null = null;

  try {
    // O MESMO handler que a tela usa, e o MESMO caminho de envio. É aqui que
    // nasce a garantia de "uma vez só": a reivindicação já levou o item para
    // `processing` com `claim_token`, e o `beforeSend` (fn_fila_envio_autorizar)
    // é o ponto de linearização do pedido ao provedor.
    const { data: autoria, error: autoriaError } = await admin
      .from("messages")
      .select("sent_by_user_id, reply_to_message_id")
      .eq("organization_id", item.organization_id)
      .eq("id", item.message_id)
      .single();
    if (autoriaError || !autoria?.sent_by_user_id) {
      throw new Error("queue_sender_unavailable");
    }
    const { data: membership, error: membershipError } = await admin
      .from("user_organizations")
      .select("role")
      .eq("organization_id", item.organization_id)
      .eq("user_id", autoria.sent_by_user_id)
      .is("revoked_at", null)
      .maybeSingle();
    if (membershipError || !membership || !roleAtLeast(membership.role, "agent")) {
      throw new Error("queue_sender_permission_revoked");
    }
    if (!item.claim_token) throw new Error("queue_claim_missing");
    const resultado = await sendMessageHandler(
        admin,
        {
          organization_id: item.organization_id,
          actor: { type: "user", id: autoria.sent_by_user_id },
          requestId: item.id,
          internalMessageId: item.message_id,
          filaDispatch: { id: item.id, token: item.claim_token },
        },
        {
          conversation_id: (mensagem as { conversation_id: string }).conversation_id,
          type: "text",
          body: corpo,
          reply_to_message_id: autoria.reply_to_message_id ?? undefined,
        },
      );

    if (!["sent", "delivered", "read"].includes(resultado.status)) {
      desfecho = resultado;
      throw new Error("delivery_not_confirmed");
    }

    await concluirEnviado(admin, item, new Date().toISOString());
    logger.info("[fila.envio] enviada", {
      organization_id: item.organization_id,
      contact_id: item.contact_id,
      message_id: item.message_id,
      fila_id: item.id,
      scheduled_at: item.scheduled_at,
      enviada_em: new Date().toISOString(),
      resultado: resultado.status,
      tentativas: item.tentativas,
    });
    return "sent";
  } catch (erro) {
    if (erro instanceof Error && erro.message === "queue_dispatch_revoked") return "ignored";

    // ─── A distinção que decide se a fila reenvia ─────────────────────────────
    //
    // "Não consegui confirmar" e "o canal recusou" são coisas diferentes, e
    // tratá-las igual é o que produz mensagem duplicada na cara do cliente.
    //
    //   RECUSA CONHECIDA — o provedor respondeu e disse que NÃO aceitou
    //   (destinatário inválido, sessão caída, número inexistente). O pedido
    //   terminou; nada foi entregue. Reenviar é seguro e é o que a pessoa
    //   espera: a fila "tenta de novo".
    //
    //   RESULTADO INCERTO — o pedido foi aceita e a resposta não chegou
    //   (timeout, conexão caiu no meio, 502). Não sabemos se o WhatsApp
    //   entregou. Reenviar PODE mandar a mesma mensagem duas vezes. Aqui a
    //   fila PARA e marca `failed` para a pessoa decidir — reconciliar antes
    //   de repetir, nunca repetir no automático.
    const codigo = codigoDoDesfecho(erro, desfecho);
    const recusaConhecida = RECUSAS_CONHECIDAS.has(codigo);
    const restamTentativas = item.tentativas < item.max_tentativas;
    const podeRepetir = recusaConhecida && restamTentativas;

    if (podeRepetir) {
      // Espera com folga exponencial a partir do intervalo configurado, para
      // que uma recusa de canal não vire rajada. O item volta a `pending` com o
      // token zerado: só o worker's próximo tick o reivindica de novo.
      const espera = Math.max(item.intervalo_s ?? 90, 30) * 2 ** (item.tentativas - 1);
      const proxima = new Date(Date.now() + espera * 1000).toISOString();
      const { error } = await admin
        .from("message_send_queue")
        .update({
          status: "pending",
          scheduled_at: proxima,
          erro: codigo,
          falho_em: new Date().toISOString(),
          atualizado_em: new Date().toISOString(),
          claim_token: null,
          locked_by: null,
          locked_at: null,
        })
        .eq("organization_id", item.organization_id)
        .eq("id", item.id)
        .eq("status", "processing")
        .eq("claim_token", item.claim_token!)
        .eq("locked_by", WORKER_ID);
      if (error) throw new Error("queue_retry_record_unavailable");
      logger.warn("[fila.envio] recusa do canal; reagendado", {
        organization_id: item.organization_id,
        message_id: item.message_id,
        fila_id: item.id,
        codigo,
        tentativa: item.tentativas,
        proxima,
      });
      return "retry";
    }

    const { error } = await admin
      .from("message_send_queue")
      .update({
        status: "failed",
        erro: recusaConhecida ? codigo : "delivery_not_confirmed",
        falho_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
        locked_by: null,
        locked_at: null,
      })
      .eq("organization_id", item.organization_id)
      .eq("id", item.id)
      .eq("status", "processing")
      .eq("claim_token", item.claim_token!)
      .eq("locked_by", WORKER_ID);
    if (error) throw new Error("queue_failure_record_unavailable");
    logger.warn("[fila.envio] envio sem confirmacao; retry automatico bloqueado", {
      organization_id: item.organization_id,
      message_id: item.message_id,
      fila_id: item.id,
      codigo,
      recusa_conhecida: recusaConhecida,
      tentativas: item.tentativas,
      max_tentativas: item.max_tentativas,
    });
    return "failed";
  }
}

/**
 * UMA RODADA. Drena o que está pronto agora e devolve.
 *
 * Não espera: a espera está em `scheduled_at`, e o cron volta. Segurar a conexão
 * aberta aqui seria o que o `ritmo-do-envio-por-token.ts` proíbe explicitamente
 * (429 em vez de sleep longo).
 */
export async function rodarFila(deps: DepsDoWorker, maximo = 20): Promise<ResultadoDaRodada> {
  const agora = deps.agora();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  await recuperarTravados(deps.admin, agora);

  const resultado: ResultadoDaRodada = { enviados: 0, reagendados: 0, esgotados: 0, ignorados: 0 };

  for (let i = 0; i < maximo; i++) {
    const item = await reivindicar(deps.admin, deps.agora());
    if (!item) break;

    const desfecho = await processarItem(deps.admin, item);
    if (desfecho === "sent") resultado.enviados++;
    else if (desfecho === "retry") resultado.reagendados++;
    else if (desfecho === "failed") resultado.esgotados++;
    else resultado.ignorados++;

    if (PAUSA_ENTRE_ITENS_MS > 0) await sleep(PAUSA_ENTRE_ITENS_MS);
  }

  logger.info("[fila.envio] rodada concluida", { ...resultado, worker: WORKER_ID });
  return resultado;
}

export { COLUNAS_DA_FILA };
