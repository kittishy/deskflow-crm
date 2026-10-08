/**
 * GET/POST /api/v1/cron/fila-de-envio — drena a fila de envio intervalado.
 *
 * ## O que este cron é
 *
 * A máquina que tira as mensagens da fila. A fila é a tabela
 * `message_send_queue` (migration 0558); o ritmo é `scheduled_at`, que a própria
 * fila calcula no clique. Aqui não há espera: o cron pega o que está VENCIDO,
 * manda, e volta. Segurar a conexão aberta seria exatamente o que
 * `lib/messaging/ritmo-do-envio-por-token.ts` proíbe — devolve 429 em vez de
 * dormir.
 *
 * ## Por que não é o `workers/agent-worker`
 *
 * Aquele worker existe para TURNOS DE AGENTE (turno de IA, follow-up do motor),
 * que já têm claim, backoff e reaper próprios em `job_queue`. Este é outro
 * trabalho: um texto que uma PESSOA escreveu, para UMA pessoa, esperando a vez
 * dele. Misturar os dois na mesma tabela faria a contagem de tentativas do agente
 * governar o texto de um atendente. Tabelas separadas, crons separados,
 * `send_ledger` o único em comum — e é justamente o que impede envio duplo.
 *
 * ## Reinício do servidor (cenário 10)
 *
 * Nada é mantido em memória. Se o processo cai com um item em `processing`, o
 * `locked_at` envelhece e `recuperarTravados` devolve para `pending` na próxima
 * rodada; o `sendWithLedger` reconcilia pelo recibo e não reenvia o que o canal
 * já aceitou. `max_tentativas` impede que isso vire laço.
 *
 * ## Concorrência (cenário 11)
 *
 * A reivindicação é `fn_fila_envio_reivindicar`, que usa `for update skip
 * locked` numa transação só. Duas instâncias pegam itens diferentes, nunca o
 * mesmo. Nada de advisory lock, que o PostgREST não oferece.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET |
 * INTERNAL_SECRET, fail-closed).
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O agendamento
 * vive no serviço `scheduler` do `docker-compose.prod.yml`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { rodarFila, type ResultadoDaRodada } from "@/lib/messaging/fila/processar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto por invocação. A rodada seguinte pega o resto — melhor que segurar cron. */
const MAXIMO_POR_RODADA = 20;

async function rodar(requestId: string): Promise<Response> {
  const admin = createAdminClient();
  const resultado: ResultadoDaRodada = await rodarFila({
    admin,
    agora: () => new Date(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  }, MAXIMO_POR_RODADA);
  return ok(resultado, { requestId });
}

async function handler(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("unauthorized", "Unauthorized.", 401, { requestId });
  }

  try {
    return await rodar(requestId);
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    logger.error("[fila.envio] cron falhou", { request_id: requestId, erro: mensagem });
    return fail("internal_error", "A fila de envio não pôde ser processada.", 500, {
      requestId,
      details: { erro: mensagem },
    });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handler(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handler(req);
}