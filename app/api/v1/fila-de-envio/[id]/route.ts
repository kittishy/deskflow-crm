/**
 * /api/v1/fila-de-envio/[id] — o item da fila e as quatro coisas que a pessoa
 * pode fazer com ele enquanto ele espera.
 *
 *   GET     o estado do item (o que a bolha e o painel consultam)
 *   PATCH   editar o texto | pausar | retomar | enviar agora
 *   DELETE  cancelar
 *
 * ─── Por que PATCH e não quatro rotas ────────────────────────────────────────
 *
 * As quatro ações mudam o MESMO recurso e só divergem na intenção. Uma rota
 * por ação repetiria quatro vezes a mesma cadeia — Zod, guard, org, filtro — e
 * quatro vezes o mesmo risco de o `where` de status ficar divergente entre
 * elas. Aqui o `where` fica em `lib/messaging/fila/operacoes.ts`, que é onde ele
 * pode ser testado.
 *
 * ─── A regra de estado é do backend, e não da tela ───────────────────────────
 *
 * "Enviar agora" NÃO é um atalho: devolve o item para `pending` com o horário
 * vencido, e o worker o envia pelo MESMO caminho, com a MESMA reivindicação e o
 * MESMO token de fence. Um caminho próprio de envio imediato seria o lugar onde
 * nasce o segundo envio sem que ninguém perceba — e "enviar agora" é justamente
 * o botão que a pessoa clica duas vezes sem querer.
 *
 * Não há ledger de reenvio nesta fila, e é deliberado: `send_ledger` pertence a
 * `job_queue` e a chave estrangeira não alcança `message_send_queue`. O que
 * segura a duplicidade aqui é o par token de fence + linearização do dispatch
 * (`fn_fila_envio_autorizar`), com resultado incerto marcado como falha visível
 * em vez de reenviado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  agendarParaAgora,
  cancelar,
  editar,
  lerMensagemEnfileirada,
  pausar,
  retomar,
} from "@/lib/messaging/fila/operacoes";
import { lerItemDaFila } from "@/lib/messaging/fila/consultas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/** `corpo` é o texto novo. Só `corpo` muda a mensagem; o resto muda o item. */
const patchSchema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("editar"), corpo: z.string().min(1).max(8_000) }),
  z.object({ acao: z.literal("pausar") }),
  z.object({ acao: z.literal("retomar") }),
  z.object({ acao: z.literal("enviar_agora") }),
]);

/** Motivo que a trilha guarda quando a ação não encontrou o item. */
const MOTIVO_POR_ACAO = {
  editar: "message.edited",
  pausar: "message.queued",
  retomar: "message.queued",
  enviar_agora: "message.queued",
  cancelar: "message.revoked",
} as const;

/**
 * Sessão + organização ativa, uma vez para as quatro ações.
 *
 * `requireRole("agent")` (em `PATCH`/`DELETE`) JÁ resolve usuário, organização e
 * o portão de org suspensa; aqui não se repete essa resolução — o que esta
 * função devolve é o cliente de leitura e a tradução, e a autorização vem do
 * COOKIE, nunca do corpo.
 */
async function comContexto(): Promise<
  | { ok: true; admin: ReturnType<typeof createAdminClient>; organizationId: string; t: (s: string) => string }
  | { ok: false; response: Response }
> {
  const requestId = randomUUID();
  const authUser = await loadAuthUser();
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");
  const ativa = await orgAtivaDaApi(authUser, requestId);
  if (!ativa.ok) return { ok: false, response: ativa.response };
  const org = ativa.org;
  if (!org) {
    return { ok: false, response: fail("no_active_org", t("No active organization."), 403, { requestId }) };
  }
  return { ok: true, admin: createAdminClient(), organizationId: org.orgId, t };
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "ID inválido.", 422);
  const auth = await comContexto();
  if (!auth.ok) return auth.response;

  const requestId = randomUUID();
  const item = await lerItemDaFila(auth.admin, auth.organizationId, id);
  if (!item) return fail("not_found", auth.t("Mensagem não está na fila."), 404, { requestId });

  // A mensagem vem junto: a bolha precisa do `edited_at` e do `status` para
  // dizer "editada depois do clique" sem uma segunda ida ao servidor.
  const mensagem = await lerMensagemEnfileirada(auth.admin, auth.organizationId, item.message_id);
  return ok({ item, mensagem }, { requestId });
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await requireRole("agent");
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "ID inválido.", 422);
  const auth = await comContexto();
  if (!auth.ok) return auth.response;
  const requestId = randomUUID();

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", auth.t("Ação inválida."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const acao = parsed.data.acao;

  try {
    let mudou = false;
    switch (acao) {
      case "editar":
        mudou = await editar(auth.admin, auth.organizationId, id, (parsed.data as { corpo: string }).corpo);
        break;
      case "pausar":
        mudou = await pausar(auth.admin, auth.organizationId, id);
        break;
      case "retomar":
        mudou = await retomar(auth.admin, auth.organizationId, id);
        break;
      case "enviar_agora":
        mudou = await agendarParaAgora(auth.admin, auth.organizationId, id);
        if (mudou) {
          const { rodarFila } = await import("@/lib/messaging/fila/processar");
          await rodarFila({ admin: auth.admin, agora: () => new Date() }, 1);
        }
        break;
    }

    // `mudou === false` não é erro 500: é o item já processado, cancelado, ou
    // uma segunda aba que clicou antes. A resposta honesta é "não foi agora,
    // olhe o estado", e o estado vem logo abaixo.
    if (mudou) {
      await audit({
        action: MOTIVO_POR_ACAO[acao],
        actorUserId: authz.user.id,
        organizationId: auth.organizationId,
        resourceType: "message_send_queue",
        resourceId: id,
        requestId,
        metadata: { acao },
      });
    }

    const item = await lerItemDaFila(auth.admin, auth.organizationId, id);
    if (!item) return fail("not_found", auth.t("Mensagem não está na fila."), 404, { requestId });
    return ok({ item, aplicado: mudou }, { requestId });
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    return fail("internal_error", auth.t("Não foi possível alterar a mensagem da fila."), 500, {
      requestId,
      details: { erro: mensagem },
    });
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await requireRole("agent");
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "ID inválido.", 422);
  const auth = await comContexto();
  if (!auth.ok) return auth.response;
  const requestId = randomUUID();

  try {
    const cancelado = await cancelar(auth.admin, auth.organizationId, id);
    if (!cancelado) {
      // Cancelar duas vezes, ou cancelar o que já saiu, não é erro: o objetivo
      // (não enviar) já está garantido. Dizer 409 faria a tela acusar falha numa
      // operação que na verdade foi um sucesso.
      const item = await lerItemDaFila(auth.admin, auth.organizationId, id);
      if (!item) return fail("not_found", auth.t("Mensagem não está na fila."), 404, { requestId });
      return ok({ item, aplicado: false }, { requestId });
    }
    await audit({
      action: MOTIVO_POR_ACAO.cancelar,
      actorUserId: authz.user.id,
      organizationId: auth.organizationId,
      resourceType: "message_send_queue",
      resourceId: id,
      requestId,
    });
    const item = await lerItemDaFila(auth.admin, auth.organizationId, id);
    return ok({ item, aplicado: true }, { requestId });
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    return fail("internal_error", auth.t("Não foi possível cancelar a mensagem."), 500, {
      requestId,
      details: { erro: mensagem },
    });
  }
}
