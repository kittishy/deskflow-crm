import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { fail, ok } from '@/lib/api/wrappers';
import { autorizaCron } from '@/lib/auth/cron-auth';
import { createApprovedReplyHandler } from '@/lib/agent-engine/agent/approved-reply';
import { requestTurnDeps } from '@/lib/agent-engine/agent/request-deps';
import { createMeetDeliveryHandler } from '@/lib/agent-engine/agent/meet-delivery';
import { createLogger } from '@/lib/agent-engine/obs/logger';
import { claimJobs, reapExpiredJobs } from '@/lib/agent-engine/queue/queue';
import { drainTick } from '@/lib/agent-engine/edge/crm/drain';
import { createPool } from '@/lib/agent-engine/db/pool';
import { loadEnv } from '@/lib/agent-engine/env';
import { runOneAssistedJob } from '@/lib/agent-engine/assisted/run-one';

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
      kinds: ['inbound_turn', 'approved_reply', 'transactional_delivery'],
    });
    if (!job) return ok({ eventsDrained, job: 'none' }, { requestId });

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
