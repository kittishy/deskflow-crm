import type pg from 'pg';

import { decidirElegibilidadeDaConversa } from '@/lib/ai/elegibilidade/consulta-pg';
import { readCurrentServiceBoundary, withServiceJob } from '@/lib/atendimento/fronteira-server';
import { parseServiceBoundary } from '@/lib/atendimento/fronteira';
import { loadConversationAgentConfig } from '../agent/agent-config';
import { generateReplyDraft } from '../agent/reply-drafts';
import type { InboundTurnDeps } from '../agent/inbound-turn';
import { claimOfJob } from '../queue/claim';
import {
  cancelJob,
  completeJob,
  failJob,
  type JobRow,
} from '../queue/queue';

const ALLOWLIST_TTL_MS = 21 * 24 * 60 * 60 * 1000;

export interface OneShotOptions {
  workerId: string;
  organizationId: string;
  createdAfter: Date;
  allowedChannelSessionIds: ReadonlySet<string>;
}

export interface OneShotDependencies {
  turn: InboundTurnDeps;
  approvedReply(job: JobRow, pool: pg.Pool): Promise<void>;
  transactionalDelivery(job: JobRow, pool: pg.Pool): Promise<void>;
}

export type OneShotResult = 'drafted' | 'settled' | 'no_job' | 'skipped' | 'retrying' | 'settle_pending';

/**
 * Executes one already-claimed job for the bounded, opt-in cron route.
 * Inbound work is draft-only. Sending remains behind the existing explicit
 * approval and transactional-delivery handlers.
 */
export async function runOneAssistedJob(
  pool: pg.Pool,
  job: JobRow,
  options: OneShotOptions,
  deps: OneShotDependencies,
): Promise<OneShotResult> {
  const claim = claimOfJob(job);
  if (!claim || job.organization_id !== options.organizationId || job.created_at < options.createdAfter) {
    return 'skipped';
  }

  if (job.kind === 'approved_reply' || job.kind === 'transactional_delivery') {
    try {
      if (job.kind === 'approved_reply') await deps.approvedReply(job, pool);
      else await deps.transactionalDelivery(job, pool);
      return 'settled';
    } catch {
      // These handlers own atomic approval/receipt settlement. Preserve their
      // recovery contract: a failed settle is recovered by the scoped reaper.
      return 'settle_pending';
    }
  }

  if (job.kind !== 'inbound_turn' || !job.contact_id) {
    await cancelJob(pool, job.id, options.workerId, 'assisted_route_kind_not_supported', claim.acquired_at);
    return 'skipped';
  }

  try {
    const conversationId = typeof job.payload.conversation_id === 'string' ? job.payload.conversation_id : '';
    if (!conversationId) {
      await cancelJob(pool, job.id, options.workerId, 'assisted_route_conversation_missing', claim.acquired_at);
      return 'skipped';
    }
    const { rows } = await pool.query<{
      is_group: boolean;
      contact_id: string;
      channel_session_id: string;
    }>(
      `select c.is_group, c.contact_id, c.channel_session_id
         from conversations c
        where c.organization_id = $1 and c.id = $2`,
      [options.organizationId, conversationId],
    );
    const conversation = rows[0];
    const channelId = conversation?.channel_session_id;
    if (
      !conversation || conversation.is_group || conversation.contact_id !== job.contact_id ||
      !channelId || !options.allowedChannelSessionIds.has(channelId)
    ) {
      await cancelJob(pool, job.id, options.workerId, 'assisted_route_channel_or_contact_not_allowed', claim.acquired_at);
      return 'skipped';
    }

    // Contact authorization, force-human, silence, organization state and the
    // channel's ai_gate all use the same policy as the normal inbound runtime.
    const eligibility = await decidirElegibilidadeDaConversa(pool, {
      organizationId: options.organizationId,
      conversationId,
      agora: new Date(),
      ttlMs: ALLOWLIST_TTL_MS,
    });
    if (!eligibility?.permite) {
      await cancelJob(pool, job.id, options.workerId, 'assisted_route_contact_not_authorized', claim.acquired_at);
      return 'skipped';
    }

    const agent = await loadConversationAgentConfig(pool, options.organizationId, conversationId, channelId);
    if (!agent || agent.operationMode !== 'assisted' || agent.pausedAt) {
      await cancelJob(pool, job.id, options.workerId, 'assisted_route_agent_not_active_assisted', claim.acquired_at);
      return 'skipped';
    }

    const draft = await withServiceJob(pool, job, async () => {
      const current = await readCurrentServiceBoundary(pool, options.organizationId, conversationId);
      const boundary = parseServiceBoundary(current);
      if (!boundary || boundary.contact_id !== job.contact_id) {
        throw new Error('assisted_route_service_boundary_unavailable');
      }
      return generateReplyDraft(pool, deps.turn, {
        organizationId: options.organizationId,
        conversationId,
        contactId: job.contact_id!,
        channelId,
        boundary,
        agent,
      });
    });

    if (draft.status === 'stale') {
      await cancelJob(pool, job.id, options.workerId, 'assisted_reply_draft_stale', claim.acquired_at);
      return 'skipped';
    }
    if (draft.status === 'generating') {
      // An existing generation owns this draft; avoid duplicate model calls.
      await cancelJob(pool, job.id, options.workerId, 'assisted_reply_draft_generation_in_progress', claim.acquired_at);
      return 'skipped';
    }
    if (draft.status === 'failed') throw new Error('assisted_reply_draft_failed');
    if (draft.status !== 'pending') throw new Error('assisted_reply_draft_unexpected_status');
    if (typeof draft.original_body !== 'string' || draft.original_body.trim().length === 0) {
      throw new Error('assisted_reply_draft_empty');
    }
    await completeJob(pool, job.id, options.workerId, undefined, claim.acquired_at);
    return 'drafted';
  } catch (error) {
    await failJob(pool, job.id, options.workerId, error, claim.acquired_at);
    return 'retrying';
  }
}
