"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { supportWriteError } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { RITMO_PADRAO, gravarRitmoEnvio, ritmoEnvioSchema } from "@/lib/messaging/fila/config";
import { createAdminClient } from "@/lib/supabase/admin";

export type SalvarRitmoResult = { ok: true } | { ok: false; error: string; campo?: string };

/**
 * Grava Configurações → WhatsApp → Ritmo de envio.
 *
 * ─── O guard é "administrar a empresa", e não "configurar o canal" ───────────
 *
 * Ritmo de envio é decisão de OPERAÇÃO DIÁRIA, não de infraestrutura: quem
 * atende decide quanto respiro entre contatos. Exigir `admin` colocaria o
 * ajuste no colo de quem não está no atendimento, e exigir papel de canal
 * colocaria no colo de quem não mexe no dia. Credencial de canal continua num
 * arquivo próprio, com o guard próprio.
 *
 * ─── Por que auditar o valor anterior ───────────────────────────────────────
 *
 * A pergunta que volta é sempre "quem mudou o ritmo e quando". A org sozinha
 * responde "quem"; o antes/depois responde o resto. Sem o `de`, uma sequência
 * de salvamentos idênticos fica indistinguível de uma troca real.
 */
export async function salvarRitmoDeEnvio(input: unknown): Promise<SalvarRitmoResult> {
  const parsed = ritmoEnvioSchema.safeParse(input);
  if (!parsed.success) {
    const caminho = parsed.error.issues[0]?.path?.[0];
    return { ok: false, error: "invalid_input", ...(caminho ? { campo: String(caminho) } : {}) };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) return { ok: false, error: "forbidden_role" };

  const supabase = createAdminClient();
  const { data: atual, error: erroLeitura } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, error: "write_failed" };

  const settings = (atual?.settings ?? null) as Record<string, unknown> | null;
  const anterior = settings?.ritmo_envio ?? RITMO_PADRAO;

  // `settings` é JSONB e o merge é feito AQUI, não no banco: um `update` de
  // objeto sobrescreveria o resto das preferências da empresa (branding,
  // routing, fuso) com o que este formulário leu.
  const { error: erroEscrita } = await supabase
    .from("organizations")
    .update({ settings: gravarRitmoEnvio(settings, parsed.data) })
    .eq("id", activeOrg.orgId);
  if (erroEscrita) return { ok: false, error: "write_failed" };

  const hdrs = await headers();
  await audit({
    action: "settings.send_pacing_updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    metadata: { bloco: "ritmo_envio", de: anterior, para: parsed.data },
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  });

  // As duas telas que mostram fila: Configurações e o Inbox (o badge).
  revalidatePath("/app/settings/whatsapp");
  revalidatePath("/app");

  return { ok: true };
}
