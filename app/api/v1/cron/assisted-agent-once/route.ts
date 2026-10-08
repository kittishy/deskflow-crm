import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { fail, ok } from '@/lib/api/wrappers';
import { autorizaCron } from '@/lib/auth/cron-auth';
import { createLogger } from '@/lib/agent-engine/obs/logger';
import { createPool } from '@/lib/agent-engine/db/pool';
import { loadEnv } from '@/lib/agent-engine/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const assistedEnv = z.object({
  AI_ASSISTED_ORGANIZATION_ID: z.uuid(),
  AI_ASSISTED_CREATED_AFTER: z.iso.datetime({ offset: true }),
  AI_ASSISTED_CHANNEL_SESSION_IDS: z.string().min(1),
});

const sessionId = z.uuid();

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail('forbidden', 'Cron secret missing or invalid.', 403, { requestId });

  const parsed = assistedEnv.safeParse({
    AI_ASSISTED_ORGANIZATION_ID: process.env.AI_ASSISTED_ORGANIZATION_ID,
    AI_ASSISTED_CREATED_AFTER: process.env.AI_ASSISTED_CREATED_AFTER,
    AI_ASSISTED_CHANNEL_SESSION_IDS: process.env.AI_ASSISTED_CHANNEL_SESSION_IDS,
  });
  if (!parsed.success) {
    return fail('assisted_dispatch_disabled', 'Assisted dispatch requires an organization, cutoff and explicit channel allowlist.', 503, { requestId });
  }
  const channelIds = parsed.data.AI_ASSISTED_CHANNEL_SESSION_IDS.split(',').map((id) => id.trim());
  if (channelIds.length === 0 || channelIds.some((id) => !sessionId.safeParse(id).success)) {
    return fail('assisted_dispatch_disabled', 'Assisted dispatch channel allowlist is invalid.', 503, { requestId });
  }

  const log = createLogger();
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    const env = loadEnv();
    pool = createPool(env.SUPABASE_DB_URL, (err) => {
      log.error('assisted cron: conexão Postgres caiu', { error: err.message.split('\n', 1)[0]?.slice(0, 300) });
    });
    const cutoff = new Date(parsed.data.AI_ASSISTED_CREATED_AFTER);
    const options = {
      organizationId: parsed.data.AI_ASSISTED_ORGANIZATION_ID,
      createdAfter: cutoff,
    };
    const kinds = ['inbound_turn', 'approved_reply', 'transactional_delivery'] as const;

    // Esse endpoint é chamado por cron de alta frequência. Na maior parte das
    // batidas não há nada para fazer; carregar o pipeline inteiro, rodar reapers
    // e abrir claims vazios desperdiça CPU da Function. Uma única consulta
    // indexável decide se existe evento/job vencido OU lease órfão a recuperar.
    const { rows: workRows } = await pool.query<{ has_work: boolean }>(
      `select (
        exists(
          select 1 from event_log
          where event_type = 'ai_agent.dispatch_requested'
            and status = 'pending'
            and (next_attempt_at is null or next_attempt_at <= now())
            and organization_id = $1
            and created_at >= $2
            and payload->>'channel_session_id' = any($3::text[])
        )
        or exists(
          select 1 from event_log
          where event_type = 'ai_agent.dispatch_requested'
            and status = 'processing'
            and 'agent-engine' = any(coalesce(consumed_by, '{}'))
            and organization_id = $1
            and created_at >= $2
            and payload->>'channel_session_id' = any($3::text[])
            and updated_at < now() - ($4 * interval '1 millisecond')
        )
        or exists(
          select 1 from job_queue
          where status = 'pending'
            and run_after <= now()
            and organization_id = $1
            and created_at >= $2
            and kind = any($5::text[])
            and (kind <> 'inbound_turn' or payload->>'channel_session_id' = any($3::text[]))
        )
        or exists(
          select 1 from job_queue
          where status = 'running'
            and locked_at < now() - ($4 * interval '1 millisecond')
            and organization_id = $1
            and created_at >= $2
        )
      ) as has_work`,
      [
        options.organizationId,
        cutoff,
        channelIds,
        env.QUEUE_VISIBILITY_TIMEOUT_MS,
        [...kinds],
      ],
    );
    if (workRows[0]?.has_work !== true) {
      return ok({ eventsDrained: 0, job: 'none', idleFastPath: true }, { requestId });
    }

    const [{ claimJobs, reapExpiredJobs }, { drainTick }] = await Promise.all([
      import('@/lib/agent-engine/queue/queue'),
      import('@/lib/agent-engine/edge/crm/drain'),
    ]);

    await reapExpiredJobs(pool, {
      visibilityTimeoutMs: env.QUEUE_VISIBILITY_TIMEOUT_MS,
      ...options,
    });
    const eventsDrained = await drainTick(pool, {
      batchSize: 1,
      intervalMs: env.CRM_DRAIN_INTERVAL_MS,
      idleIntervalMs: env.CRM_DRAIN_IDLE_INTERVAL_MS,
      debounceMs: env.INBOUND_DEBOUNCE_MS,
      reapTimeoutMs: env.QUEUE_VISIBILITY_TIMEOUT_MS,
      organizationId: options.organizationId,
      createdAfter: cutoff,
      channelSessionIds: channelIds,
    }, log);

    const workerId = `assisted-cron-${randomUUID()}`;
    const [job] = await claimJobs(pool, {
      workerId,
      maxConcurrency: env.QUEUE_MAX_CONCURRENCY,
      batchSize: 1,
      ...options,
      channelSessionIds: channelIds,
      kinds,
    });
    if (!job) return ok({ eventsDrained, job: 'none' }, { requestId });

    // O caminho caro (agente/handlers) só entra no bundle ativo desta invocação
    // quando um job foi realmente claimado.
    const [
      { requestTurnDeps },
      { createApprovedReplyHandler },
      { createMeetDeliveryHandler },
      { runOneAssistedJob },
    ] = await Promise.all([
      import('@/lib/agent-engine/agent/request-deps'),
      import('@/lib/agent-engine/agent/approved-reply'),
      import('@/lib/agent-engine/agent/meet-delivery'),
      import('@/lib/agent-engine/assisted/run-one'),
    ]);

    const turn = requestTurnDeps();
    const outcome = await runOneAssistedJob(pool, job, {
      workerId,
      ...options,
      allowedChannelSessionIds: new Set(channelIds),
    }, {
      turn,
      approvedReply: createApprovedReplyHandler(turn),
      transactionalDelivery: createMeetDeliveryHandler(turn),
    });
    return ok({ eventsDrained, jobId: job.id, outcome }, { requestId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error('assisted-agent-once cron failed', { error: detail.slice(0, 300), requestId });
    return fail('internal_error', 'Assisted dispatch failed.', 500, { requestId });
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
