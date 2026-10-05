/**
 * A LEITURA do painel público — a única parte do caminho que fala com o banco.
 *
 * ─── A regra que este arquivo existe para proteger ───────────────────────────
 *
 * `organization_id` NUNCA vem de quem pede. A credencial do painel público é o
 * UUID da linha, e a organização é a que está gravada NESSA linha: quem tem o
 * link vê a conta de quem o criou, e não a conta que o link tentar dizer. Todo o
 * resto aqui é consequence — cada query leva `.eq("organization_id", ...)` com o
 * id que saiu da linha, porque `createAdminClient()` usa service role, que
 * bypassa RLS (`lib/supabase/admin.ts`). Sem o filtro manual, o número de uma
 * organização apareceria no painel de outra sem nenhum sinal.
 *
 * ─── Por que a conta NÃO é feita por RPC de sessão ──────────────────────────
 *
 * `app/api/v1/metrics/*` usa `fn_attendant_metrics`/`fn_atrito_metrics`, que são
 * SECURITY INVOKER de propósito: o escopo vem da RLS do usuário logado. Aqui não
 * existe usuário — o que existe é um painel que a organização optou por
 * compartilhar. As DUAS coisas que esses RPCs entregam e que valem a pena
 * reusar são a REGRA (`montarPares`/`agruparPerdas`, em `lib/metrics/*`) e o
 * atrito (`fn_atrito_metrics`, com `p_org` vindo daqui). A contagem de negócio
 * e de conversa é feita por `count` explícito com filtro de organização: é a
 * mesma conta que o painel interno mostra, sem depender de quem tem a conversa
 * atribuída.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { lerAbandonoHoras, type AtritoRaw } from "@/lib/metrics/atrito";
import { agruparPerdas, type PerdaLinha } from "@/lib/metrics/perdas";
import { logger } from "@/lib/logger";

import { montarMetricasPublicas, resolverJanela, type MetricasPublicas } from "./metricas";

/**
 * Teto da leitura de perdas. Acima disso o relatório diz que está cortado em vez
 * de mentir com uma categoria incompleta — o mesmo corte e o mesmo porquê de
 * `app/api/v1/metrics/lost` (que usa 5000).
 */
const LIMITE_DE_PERDAS = 2000;

export interface PainelPublico {
  id: string;
  organizationId: string;
  title: string;
  windowDays: number;
}

/** Colunas lidas de `public_panels` — nem uma a mais. */
const COLUNAS_DO_PAINEL = "id, organization_id, enabled, title, window_days";

/**
 * A linha do painel, ou `null`.
 *
 * `null` cobre TRÊS casos que são indistinguíveis de propósito: painel
 * inexistente, painel desligado e banco fora do ar. Quem recebe o mesmo desenho
 * nos três não consegue distinguir "você não tem acesso" de "não existe", e essa
 * é a propriedade que impede sondar quais UUIDs existem na instalação.
 */
export async function resolverPainelPublico(
  admin: SupabaseClient,
  id: string,
): Promise<PainelPublico | null> {
  const { data, error } = await admin
    .from("public_panels")
    .select(COLUNAS_DO_PAINEL)
    .eq("id", id)
    .eq("enabled", true)
    .maybeSingle();

  if (error) {
    logger.warn("painel publico: painel nao resolvido", { codigo: error.code });
    return null;
  }
  if (!data) return null;

  return {
    id: data.id,
    organizationId: data.organization_id,
    title: data.title,
    windowDays: data.window_days,
  };
}

/** Uma contagem que o banco devolveu mas que ninguém sabe ler. */
function numeroOuZero(cru: unknown): number {
  return typeof cru === "number" && Number.isFinite(cru) ? cru : 0;
}

/**
 * As métricas agregadas da organização dona do painel.
 *
 * Cinco leituras independentes, em paralelo. Cada uma é filtrada por
 * organização, e nenhuma derruba as outras: a que pode faltar sem estragar o
 * painel é a de ATRITO, e ela volta como `medidas: []` — "não medido", nunca
 * zero. As contagens devolvem 0 no erro e registram o motivo, porque um painel
 * que some com um número é pior do que um que mostra 0 com a régua escrita do
 * lado.
 */
export async function lerMetricasPublicas(
  admin: SupabaseClient,
  painel: PainelPublico,
  agora: Date = new Date(),
): Promise<MetricasPublicas> {
  const janela = resolverJanela(painel.windowDays, agora);
  const org = painel.organizationId;

  const [ganhos, perdidos, conversas, perda, atrito] = await Promise.all([
    contarNegocios(admin, org, "won", janela.de, janela.ate),
    contarNegocios(admin, org, "lost", janela.de, janela.ate),
    contarConversas(admin, org, janela.de, janela.ate),
    lerPerdas(admin, org, janela.de, janela.ate),
    lerAtrito(admin, org, janela),
  ]);

  return montarMetricasPublicas({
    janela,
    ganhos,
    perdidos,
    conversas,
    atrito,
    perdas: perda,
  });
}

async function contarNegocios(
  admin: SupabaseClient,
  org: string,
  status: "won" | "lost",
  de: string,
  ate: string,
): Promise<number> {
  const { count, error } = await admin
    .from("crm_leads")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org)
    .eq("status", status)
    .gte("closed_at", de)
    .lt("closed_at", ate);
  if (error) {
    logger.warn("painel publico: contagem de negocios falhou", {
      status,
      codigo: error.code,
    });
    return 0;
  }
  return numeroOuZero(count);
}

/** Conversas INICIADAS na janela — o que a pessoa de fora lê como "atendimentos". */
async function contarConversas(
  admin: SupabaseClient,
  org: string,
  de: string,
  ate: string,
): Promise<number> {
  const { count, error } = await admin
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org)
    .gte("created_at", de)
    .lt("created_at", ate);
  if (error) {
    logger.warn("painel publico: contagem de conversas falhou", { codigo: error.code });
    return 0;
  }
  return numeroOuZero(count);
}

/**
 * As linhas de perda da janela, agrupadas por `agruparPerdas` — a conta é a
 * mesma da tela interna, incluindo a regra de que transferência entre funis não
 * é perda. Só o rótulo de CATEGORIA entra na saída pública; o motivo cru e o
 * valor em moeda ficam aqui dentro.
 */
async function lerPerdas(
  admin: SupabaseClient,
  org: string,
  de: string,
  ate: string,
): Promise<ReturnType<typeof agruparPerdas>> {
  const { data, error } = await admin
    .from("crm_leads")
    .select("lost_reason, lost_from_stage_id, value_cents, currency, pipeline_id")
    .eq("organization_id", org)
    .eq("status", "lost")
    .gte("closed_at", de)
    .lt("closed_at", ate)
    .limit(LIMITE_DE_PERDAS);

  if (error) {
    logger.warn("painel publico: leitura de perdas falhou", { codigo: error.code });
    return agruparPerdas([]);
  }
  const linhas = (data ?? []) as PerdaLinha[];
  if (linhas.length >= LIMITE_DE_PERDAS) {
    logger.warn("painel publico: leitura de perdas cortada no teto", {
      teto: LIMITE_DE_PERDAS,
    });
  }
  return agruparPerdas(linhas);
}

/**
 * O Índice de Atrito pelo mesmo RPC do painel interno, com `p_org` vindo da
 * LINHA DO PAINEL. A régua do abandono vem da organização pelo mesmo motivo da
 * rota interna: um número cuja definição muda sem aviso não se compara com o de
 * ontem.
 */
async function lerAtrito(
  admin: SupabaseClient,
  org: string,
  janela: { de: string; ate: string },
): Promise<AtritoRaw | null> {
  const { data: orgRow } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org)
    .maybeSingle();
  const abandonoHoras = lerAbandonoHoras(orgRow?.settings);

  const { data, error } = await admin.rpc("fn_atrito_metrics", {
    p_org: org,
    p_from: janela.de,
    p_to: janela.ate,
    p_abandono_horas: abandonoHoras,
  });
  if (error) {
    // Sem atrito medido, o painel publica a lista de medidas VAZIA. Voltar com
    // zero faria a tela escrever "0% de abandono" numa instalação cujo banco
    // estava lento — a frase que a falta de medição não autoriza.
    logger.warn("painel publico: atrito indisponivel", { codigo: error.code });
    return null;
  }
  if (!data) return null;
  return data as AtritoRaw;
}
