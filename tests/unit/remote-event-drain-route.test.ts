import { beforeEach, describe, expect, it, vi } from 'vitest';

const drainEventLog = vi.fn();
const createAdminClient = vi.fn();
const registerHandler = vi.fn();
const autorizaCron = vi.fn();

vi.mock('@/lib/event-log/drain', () => ({ drainEventLog }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }));
vi.mock('@/lib/event-log/dispatcher', () => ({ registerHandler }));
vi.mock('@/lib/auth/cron-auth', () => ({ autorizaCron }));
vi.mock('@/lib/agent-engine/obs/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('@/workers/media-persist-worker.handler', () => ({ mediaPersistHandler: { key: 'media_persist_v1', events: ['media.persist_requested'], naOrgParada: 'roda', handle: vi.fn() } }));
vi.mock('@/workers/media-derive-worker.handler', () => ({ mediaDeriveHandler: { key: 'media_derive_v1', events: ['media.derive_requested'], naOrgParada: 'pula', handle: vi.fn() } }));
vi.mock('@/workers/rag-indexer.handler', () => ({ ragIndexerHandler: { key: 'rag-indexer.v1', events: ['knowledge_source.updated', 'nuvemshop.product_synced'], naOrgParada: 'pula', handle: vi.fn() } }));
vi.mock('@/lib/notifications/push.handler', () => ({ webPushInboundHandler: { key: 'web-push-inbound.v1', events: ['message.received', 'message.group_received', 'lead.assigned'], naOrgParada: 'roda', handle: vi.fn() } }));

const { GET } = await import('@/app/api/v1/cron/remote-event-drain/route');
const ORG = '5b9ecabb-2f26-4c54-a7a7-79078a381ca1';
const CHANNEL = '94656be6-21a9-41c4-a867-c84c082d03ef';

function req(): never {
  return new Request('https://deskflow.test/api/v1/cron/remote-event-drain') as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  autorizaCron.mockReturnValue(true);
  createAdminClient.mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: [{ id: CHANNEL }], error: null })),
    })),
  });
  drainEventLog.mockResolvedValue({ scanned: 0, done: 0, retried: 0, failed: 0, dead: 0 });
});

describe('remote event drain route', () => {
  it('rejects unauthenticated calls without opening the database', async () => {
    autorizaCron.mockReturnValue(false);
    const response = await GET(req());
    expect(response.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it('fails closed on missing opt-in configuration before database access', async () => {
    const old = {
      org: process.env.AI_ASSISTED_ORGANIZATION_ID,
      cutoff: process.env.AI_ASSISTED_CREATED_AFTER,
      channels: process.env.AI_ASSISTED_CHANNEL_SESSION_IDS,
    };
    delete process.env.AI_ASSISTED_ORGANIZATION_ID;
    delete process.env.AI_ASSISTED_CREATED_AFTER;
    delete process.env.AI_ASSISTED_CHANNEL_SESSION_IDS;
    try {
      const response = await GET(req());
      expect(response.status).toBe(503);
      expect(createAdminClient).not.toHaveBeenCalled();
    } finally {
      if (old.org === undefined) delete process.env.AI_ASSISTED_ORGANIZATION_ID; else process.env.AI_ASSISTED_ORGANIZATION_ID = old.org;
      if (old.cutoff === undefined) delete process.env.AI_ASSISTED_CREATED_AFTER; else process.env.AI_ASSISTED_CREATED_AFTER = old.cutoff;
      if (old.channels === undefined) delete process.env.AI_ASSISTED_CHANNEL_SESSION_IDS; else process.env.AI_ASSISTED_CHANNEL_SESSION_IDS = old.channels;
    }
  });

  it('passes only the scoped handler/event allowlists and caps each tick at three', async () => {
    process.env.AI_ASSISTED_ORGANIZATION_ID = ORG;
    process.env.AI_ASSISTED_CREATED_AFTER = '2026-10-02T09:00:00.000Z';
    process.env.AI_ASSISTED_CHANNEL_SESSION_IDS = CHANNEL;
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect(drainEventLog).toHaveBeenCalledOnce();
    const [, options] = drainEventLog.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(options).toMatchObject({ limit: 3, organizationId: ORG, eventTypes: expect.arrayContaining(['media.persist_requested', 'media.derive_requested', 'knowledge_source.updated', 'message.received']) });
    expect(options.handlerKeys).toEqual(['media_persist_v1', 'media_derive_v1', 'rag-indexer.v1', 'web-push-inbound.v1']);
    expect(registerHandler).toHaveBeenCalledTimes(4);
    const registered = registerHandler.mock.calls.map(([handler]) => handler as { events: string[] });
    expect(registered.flatMap((handler) => handler.events)).not.toContain('lead.assigned');
  });
});
