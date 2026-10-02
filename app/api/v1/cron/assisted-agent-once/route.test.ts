import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorized: false,
  createPool: vi.fn(),
  drain: vi.fn(),
  reap: vi.fn(),
  claim: vi.fn(),
  runOne: vi.fn(),
  poolEnd: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({ autorizaCron: () => mocks.authorized }));
vi.mock('@/lib/agent-engine/db/pool', () => ({ createPool: mocks.createPool }));
vi.mock('@/lib/agent-engine/edge/crm/drain', () => ({ drainTick: mocks.drain }));
vi.mock('@/lib/agent-engine/queue/queue', () => ({ claimJobs: mocks.claim, reapExpiredJobs: mocks.reap }));
vi.mock('@/lib/agent-engine/assisted/run-one', () => ({ runOneAssistedJob: mocks.runOne }));
vi.mock('@/lib/agent-engine/agent/request-deps', () => ({ requestTurnDeps: () => ({}) }));
vi.mock('@/lib/agent-engine/agent/approved-reply', () => ({ createApprovedReplyHandler: () => vi.fn() }));
vi.mock('@/lib/agent-engine/agent/meet-delivery', () => ({ createMeetDeliveryHandler: () => vi.fn() }));
vi.mock('@/lib/agent-engine/env', () => ({ loadEnv: () => ({
  SUPABASE_DB_URL: 'postgresql://db.example/postgres',
  QUEUE_VISIBILITY_TIMEOUT_MS: 600_000,
  CRM_DRAIN_INTERVAL_MS: 2_000,
  CRM_DRAIN_IDLE_INTERVAL_MS: 15_000,
  INBOUND_DEBOUNCE_MS: 0,
  QUEUE_MAX_CONCURRENCY: 8,
}) }));
vi.mock('@/lib/agent-engine/obs/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

const ORG = '33333333-3333-4333-8333-333333333333';
const CHANNEL = '44444444-4444-4444-8444-444444444444';

async function route(req: Request): Promise<Response> {
  const { POST } = await import('./route');
  return POST(req as never);
}

beforeEach(() => {
  vi.resetModules();
  mocks.authorized = false;
  mocks.createPool.mockReset().mockReturnValue({ end: mocks.poolEnd });
  mocks.drain.mockReset().mockResolvedValue(0);
  mocks.reap.mockReset().mockResolvedValue({ revived: 0, dead: 0 });
  mocks.claim.mockReset().mockResolvedValue([]);
  mocks.runOne.mockReset();
  mocks.poolEnd.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('cron assistido de um job', () => {
  it('nega chamadas sem autorização antes de ler configuração ou abrir pool', async () => {
    const res = await route(new Request('http://local/api/v1/cron/assisted-agent-once', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect(mocks.createPool).not.toHaveBeenCalled();
  });

  it('fica desabilitado até receber org, cutoff e allowlist de sessões', async () => {
    mocks.authorized = true;
    const res = await route(new Request('http://local/api/v1/cron/assisted-agent-once', { method: 'POST' }));
    expect(res.status).toBe(503);
    expect(mocks.createPool).not.toHaveBeenCalled();
  });

  it('drena e claima no máximo um job apenas no tenant/cutoff/kinds optados', async () => {
    mocks.authorized = true;
    vi.stubEnv('AI_ASSISTED_ORGANIZATION_ID', ORG);
    vi.stubEnv('AI_ASSISTED_CREATED_AFTER', '2026-10-01T00:00:00.000Z');
    vi.stubEnv('AI_ASSISTED_CHANNEL_SESSION_IDS', CHANNEL);
    const res = await route(new Request('http://local/api/v1/cron/assisted-agent-once', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(mocks.reap).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: ORG }));
    expect(mocks.drain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      batchSize: 1, organizationId: ORG, createdAfter: new Date('2026-10-01T00:00:00.000Z'), channelSessionIds: [CHANNEL],
    }), expect.anything());
    expect(mocks.claim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      batchSize: 1, organizationId: ORG, channelSessionIds: [CHANNEL], kinds: ['inbound_turn', 'approved_reply', 'transactional_delivery'],
    }));
    expect(mocks.runOne).not.toHaveBeenCalled();
    expect(mocks.poolEnd).toHaveBeenCalledOnce();
  });
});
