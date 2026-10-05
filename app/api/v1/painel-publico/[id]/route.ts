/**
 * GET /api/v1/painel-publico/[id] — as métricas do painel, sem login.
 *
 * ─── A credencial é o UUID DA LINHA ──────────────────────────────────────────
 *
 * Quem abre não tem cookie de sessão e não pode ter: é o cliente, o parceiro, a
 * pessoa que recebeu o link. A autenticação deste recurso é a existência da
 * linha em `public_panels` com `enabled = true` — e a organização do painel é a
 * que está gravada NESSA linha, nunca uma que venha no pedido. Service role
 * bypassa RLS (`lib/supabase/admin.ts`), então esse filtro é o único que separa
 * a conta de quem tem o link da conta de quem não tem; ele mora em
 * `lib/painel-publico/resolver.ts` e é coberto por `resolver.test.ts`.
 *
 * ─── O que esta rota NÃO faz ────────────────────────────────────────────────
 *
 * Não autentica ninguém, não recebe `organization_id`, não aceita `from`/`to`
 * (a janela é da LINHA: um link que a pessoa controla mediria o período que ela
 * quisesse), não devolve PII e não grava nada — logo, sem `audit()`.
 *
 * ⚠️ ESTA ROTA PRECISA DE ENTRADA EM `lib/auth/public-paths.ts` para existir sem
 * sessão: o `proxy.ts` devolve 401 em `/api/**` quando o caminho não é público e
 * não há usuário, e devolve 307 para `/login` nas páginas. O padrão é o de
 * `app/api/v1/rastreio/[id]/route.ts` (migration 0437), com a mesma âncora em
 * forma de UUID para nenhum sub-path futuro nascer público de carona.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { clientIp } from "@/lib/plataformas-de-anuncio/pagina-de-captura";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerMetricasPublicas, resolverPainelPublico } from "@/lib/painel-publico/resolver";

export const dynamic = "force-dynamic";

/**
 * Teto por IP e por painel, na janela de um minuto.
 *
 * O link pode ser embutido numa página que carrega sozinha (o painel é
 * compartilhável), então o teto é generoso — mas não infinito: o custo de uma
 * leitura é um `count` sobre a tabela da organização, e um laço de reload numa
 * página pública é exatamente o caso que a PUBLIC key de alguém já paga.
 */
const LIMITE_POR_MINUTO = 120;
const JANELA_DE_LIMITE_SEGUNDOS = 60;

/** ID de painel que não existe: o mesmo 404 do painel desligado e do banco fora. */
function naoEncontrado(requestId: string) {
  return fail("not_found", "Painel não encontrado.", 404, { requestId });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();

  // Forma de UUID, e não `[^/]+`: id fora de forma é 404 SEM tocar o banco —
  // nem consulta, nem contagem, nem vaza se existe algo com esse nome.
  const id = z.uuid().safeParse((await ctx.params).id);
  if (!id.success) return naoEncontrado(requestId);

  const ip = clientIp(req);
  if (
    ip &&
    !(
      await checkRateLimit(
        `painel-publico:${id.data}:${ip}`,
        LIMITE_POR_MINUTO,
        JANELA_DE_LIMITE_SEGUNDOS,
      )
    ).allowed
  ) {
    return fail("rate_limited", "Muitas consultas ao painel. Tente de novo em um minuto.", 429, {
      requestId,
      headers: { "Retry-After": String(JANELA_DE_LIMITE_SEGUNDOS) },
    });
  }

  const admin = createAdminClient();
  // `organization_id` vem da LINHA do painel — nunca do pedido.
  const painel = await resolverPainelPublico(admin, id.data);
  if (!painel) return naoEncontrado(requestId);

  const metricas = await lerMetricasPublicas(admin, painel);

  return ok(
    {
      painel: {
        id: painel.id,
        title: painel.title,
        // A organização NÃO volta: quem lê já sabe de quem é, e devolver o id
        // faria o link servir de sondador para o resto da API.
      },
      ...metricas,
    },
    { requestId, headers: { "Cache-Control": "no-store" } },
  );
}
