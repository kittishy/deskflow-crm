import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { fail, ok } from '@/lib/api/wrappers';
import { autorizaCron } from '@/lib/auth/cron-auth';
import { registerHandler } from '@/lib/event-log/dispatcher';
import { drainEventLog } from '@/lib/event-log/drain';
import { createLogger } from '@/lib/agent-engine/obs/logger';
import { createAdminClient } from '@/lib/supabase/admin';
import { mediaPersistHandler } from '@/workers/media-persist-worker.handler';
import { mediaDeriveHandler } from '@/workers/media-derive-worker.handler';
import { ragIndexerHandler } from '@/workers/rag-indexer.handler';
import { webPushInboundHandler } from '@/lib/notifications/push.handler';
import type { EventRow } from '@/lib/event-log/dispatcher';
import type { SupabaseClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const configSchema = z.object({
  organizationId: z.uuid(),
  createdAfter: z.iso.datetime({ offset: true }),
  channelSessionIds: z.string().min(1),
});
const uuid = z.uuid();
const inboundPushHandler = {
  ...webPushInboundHandler,
  events: ['message.received', 'message.group_received'],
};
const handlers = [mediaPersistHandler, mediaDeriveHandler, ragIndexerHandler, inboundPushHandler] as const;
const handlerKeys = handlers.map((handler) => handler.key);
const eventTypes = [...new Set(handlers.flatMap((handler) => handler.events))];
const channelEvents = new Set([
  'media.persist_requested', 'media.derive_requested', 'message.received', 'message.group_received',
]);
const allowedChannelIdsFromConfig = (ids: string[]) => new Set(ids);

async function isAllowedChannelEvent(row: EventRow, admin: SupabaseClient, allowed: Set<string>): Promise<boolean> {
  if (!channelEvents.has(row.event_type)) return true;
  const payloadId = row.event_type.startsWith('media.')
    ? (typeof row.payload.message_id === 'string' ? row.payload.message_id : row.entity_id)
    : row.payload.conversation_id;
  if (typeof payloadId !== 'string' || !uuid.safeParse(payloadId).success) return false;
  const table = row.event_type.startsWith('media.') ? 'messages' : 'conversations';
  const { data, error } = await admin.from(table)
    .select('channel_session_id')
    .eq('id', payloadId)
    .eq('organization_id', row.organization_id)
    .maybeSingle();
  if (error || !data || typeof data.channel_session_id !== 'string') return false;
  return allowed.has(data.channel_session_id);
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail('forbidden', 'Cron secret missing or invalid.', 403, { requestId });

  const parsed = configSchema.safeParse({
    organizationId: process.env.AI_ASSISTED_ORGANIZATION_ID,
    createdAfter: process.env.AI_ASSISTED_CREATED_AFTER,
    channelSessionIds: process.env.AI_ASSISTED_CHANNEL_SESSION_IDS,
  });
  if (!parsed.success) {
    return fail('remote_drain_disabled', 'Remote drain requires an organization, cutoff and explicit channel allowlist.', 503, { requestId });
  }
  const channelIds = parsed.data.channelSessionIds.split(',').map((id) => id.trim());
  if (!channelIds.length || channelIds.some((id) => !uuid.safeParse(id).success) || new Set(channelIds).size !== channelIds.length) {
    return fail('remote_drain_disabled', 'Remote drain channel allowlist is invalid.', 503, { requestId });
  }

  const log = createLogger();
  try {
    const admin = createAdminClient();
    const { data: sessions, error: sessionError } = await admin.from('channel_sessions')
      .select('id')
      .eq('organization_id', parsed.data.organizationId)
      .in('id', channelIds);
    if (sessionError || !sessions || sessions.length !== channelIds.length) {
      return fail('remote_drain_disabled', 'Remote drain channel allowlist could not be verified.', 503, { requestId });
    }

    // This route deliberately registers only the four bounded consumers. The
    // drain and dispatcher also receive handlerKeys so a previously populated
    // process-wide registry cannot widen this route's effects.
    for (const handler of handlers) registerHandler(handler);
    const allowedChannelIds = allowedChannelIdsFromConfig(channelIds);
    const summary = await drainEventLog(admin, {
      limit: 3,
      organizationId: parsed.data.organizationId,
      createdAfter: new Date(parsed.data.createdAfter),
      eventTypes,
      handlerKeys,
      beforeClaim: (row, client) => isAllowedChannelEvent(row, client, allowedChannelIds),
    });
    return ok(summary, { requestId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error('remote-event-drain cron failed', { error: detail.slice(0, 300), requestId });
    return fail('internal_error', 'Remote event drain failed.', 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> { return handle(req); }
export async function POST(req: NextRequest): Promise<Response> { return handle(req); }
