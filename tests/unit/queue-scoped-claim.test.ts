import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { claimJobs, reapExpiredJobs } from '@/lib/agent-engine/queue/queue';

describe('claim e reaper por escopo', () => {
  it('claim aplica org/cutoff/kinds na transação e conta capacidade da org', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return sql.includes('count(*)') ? { rows: [{ n: 0 }] } : { rows: [] };
      }),
      release: vi.fn(),
    };
    const cutoff = new Date('2026-10-01T00:00:00.000Z');
    await claimJobs({ connect: async () => client } as unknown as pg.Pool, {
      workerId: 'assisted-cron', maxConcurrency: 1, batchSize: 1,
      organizationId: 'org-1', createdAfter: cutoff,
      channelSessionIds: ['44444444-4444-4444-8444-444444444444'],
      kinds: ['inbound_turn', 'approved_reply', 'transactional_delivery'],
    });
    const count = calls.find((c) => c.sql.includes('count(*)'))!;
    expect(count.sql).toContain('organization_id = $1');
    expect(count.params).toEqual(['org-1', cutoff]);
    const claim = calls.find((c) => c.sql.includes('with dedup'))!;
    expect(claim.sql).toContain('j.organization_id = $3');
    expect(claim.sql).toContain('j.created_at >= $4');
    expect(claim.sql).toContain('j.kind = any($5::text[])');
    expect(claim.sql).toContain("j.payload->>'channel_session_id' = any($6::text[])");
    expect(claim.params).toEqual([1, 'assisted-cron', 'org-1', cutoff, ['inbound_turn', 'approved_reply', 'transactional_delivery'], ['44444444-4444-4444-8444-444444444444']]);
  });

  it('reaper aplica a mesma organização e cutoff na atualização atômica', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const cutoff = new Date('2026-10-01T00:00:00.000Z');
    await reapExpiredJobs({ query } as never, {
      visibilityTimeoutMs: 600_000, organizationId: 'org-1', createdAfter: cutoff,
    });
    expect(query.mock.calls[0]?.[0]).toContain('organization_id = $2');
    expect(query.mock.calls[0]?.[0]).toContain('created_at >= $3');
    expect(query.mock.calls[0]?.[1]).toEqual([600_000, 'org-1', cutoff]);
  });
});
