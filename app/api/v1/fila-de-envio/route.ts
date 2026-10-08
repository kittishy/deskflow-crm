/**
 * GET /api/v1/fila-de-envio — a fila completa, na ordem prevista de saída.
 *
 * Serve o clique em "Fila de envio: 7 mensagens" e o badge do contador. A
 * ordem é a mesma do worker (prioridade, depois horário), para que o que a
 * tela promete e o que sai sejam a mesma coisa.
 *
 * `somente_aguardando=true` devolve só o número do badge, sem as linhas: é o que
 * a tela do inbox chama a cada poucos segundos, e é bem mais barato que a fila
 * inteira.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { contarAguardando, listarFila } from "@/lib/messaging/fila/consultas";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
const querySchema = z.object({
  somente_aguardando: z.enum(["true", "false"]).optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const parameters = new URL(req.url).searchParams;
  const parsed = querySchema.safeParse({
    somente_aguardando: parameters.get("somente_aguardando") ?? undefined,
    limite: parameters.get("limite") ?? undefined,
  });
  if (!parsed.success) return fail("validation_failed", "Query inválida.", 422, { requestId });
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return fail("unauthenticated", "Auth required.", 401, { requestId });

  const authUser = await loadAuthUser();
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");
  const ativa = await orgAtivaDaApi(authUser, requestId);
  if (!ativa.ok) return ativa.response;
  const org = ativa.org;
  if (!org) return fail("no_active_org", t("No active organization."), 403, { requestId });

  // Leitura pela sessão: a org vem do cookie, nunca da query. `service role` só
  // alcança a tabela nova; toda query filtra `organization_id`.
  const admin = createAdminClient();
  try {
    if (parsed.data.somente_aguardando === "true") {
      const aguardando = await contarAguardando(admin, org.orgId);
      return ok({ aguardando }, { requestId });
    }

    const fila = await listarFila(admin, org.orgId, parsed.data.limite);
    const aguardando = await contarAguardando(admin, org.orgId);
    return ok(fila, { requestId, meta: { aguardando } });
  } catch (err) {
    void err;
    return fail("internal_error", t("Não foi possível ler a fila de envio."), 500, { requestId });
  }
}
