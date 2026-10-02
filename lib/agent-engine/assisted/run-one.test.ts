import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eligibility: vi.fn(),
  boundary: vi.fn(),
  loadAgent: vi.fn(),
  draft: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
  fail: vi.fn(),
  approved: vi.fn(),
  delivery: vi.fn(),
}));

vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({ decidirElegibilidadeDaConversa: mocks.eligibility }));
vi.mock('@/lib/atendimento/fronteira', () => ({ parseServiceBoundary: (x: unknown) => x }));
vi.mock('@/lib/atendimento/fronteira-server', () => ({
  readCurrentServiceBoundary: mocks.boundary,
  withServiceJob: (_pool: unknown, _job: unknown, action: () => Promise<unknown>) => action(),
}));
vi.mock('../agent/agent-config', () => ({ loadConversationAgentConfig: mocks.loadAgent }));
vi.mock('../agent/reply-drafts', () => ({ generateReplyDraft: mocks.draft }));
vi.mock('../queue/queue', () => ({
  cancelJob: mocks.cancel,
  completeJob: mocks.complete,
  failJob: mocks.fail,
}));

import { runOneAssistedJob, type OneShotOptions } from './run-one';

const opts: OneShotOptions = {
  workerId: 'cron-1', organizationId: 'org-1', createdAfter: new Date('2026-10-01T00:00:00Z'),
  allowedChannelSessionIds: new Set(['channel-1']),
};
const boundary = {
  organization_id: 'org-1', contact_id: 'contact-1', conversation_id: 'conversation-1',
  service_revision: 1, demanda_id: null, demanda_revision: null,
};
function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1', organization_id: 'org-1', contact_id: 'contact-1', kind: 'inbound_turn',
    payload: { conversation_id: 'conversation-1' }, status: 'running', priority: 1,
    run_after: new Date(), attempts: 1, max_attempts: 5, last_error: null,
    locked_by: 'cron-1', locked_at: new Date(), claim_acquired_at: '2026-10-02T12:00:00Z',
    source_event_id: null, created_at: new Date('2026-10-02T12:00:00Z'), ...overrides,
  } as never;
}
const pool = { query: vi.fn() } as never;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.eligibility.mockResolvedValue({ permite: true });
  mocks.boundary.mockResolvedValue(boundary);
  mocks.loadAgent.mockResolvedValue({ agentId: 'agent-1', versionId: 'version-1', operationMode: 'assisted' });
  mocks.approved.mockResolvedValue(undefined);
  mocks.delivery.mockResolvedValue(undefined);
  mocks.draft.mockResolvedValue({ status: 'pending', original_body: 'Rascunho de teste' });
});

describe('execução assistida de um job inbound', () => {
  it('não gera rascunho para grupos', async () => {
    (pool as { query: ReturnType<typeof vi.fn> }).query.mockResolvedValueOnce({ rows: [{
      is_group: true, contact_id: 'contact-1', channel_session_id: 'channel-1',
    }] });
    expect(await runOneAssistedJob(pool, job(), opts, {
      turn: {} as never, approvedReply: mocks.approved, transactionalDelivery: mocks.delivery,
    })).toBe('skipped');
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalled();
  });

  it('não gera rascunho fora da allowlist explícita do canal', async () => {
    (pool as { query: ReturnType<typeof vi.fn> }).query.mockResolvedValueOnce({ rows: [{
      is_group: false, contact_id: 'contact-1', channel_session_id: 'personal-channel',
    }] });
    await runOneAssistedJob(pool, job(), opts, {
      turn: {} as never, approvedReply: mocks.approved, transactionalDelivery: mocks.delivery,
    });
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalled();
  });

  it('não gera rascunho para contato sem autorização', async () => {
    (pool as { query: ReturnType<typeof vi.fn> }).query.mockResolvedValueOnce({ rows: [{
      is_group: false, contact_id: 'contact-1', channel_session_id: 'channel-1',
    }] });
    mocks.eligibility.mockResolvedValueOnce({ permite: false });
    await runOneAssistedJob(pool, job(), opts, {
      turn: {} as never, approvedReply: mocks.approved, transactionalDelivery: mocks.delivery,
    });
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalled();
  });

  it('gera rascunho apenas para agente assistido e completa o job sem envio automático', async () => {
    (pool as { query: ReturnType<typeof vi.fn> }).query.mockResolvedValueOnce({ rows: [{
      is_group: false, contact_id: 'contact-1', channel_session_id: 'channel-1',
    }] });
    expect(await runOneAssistedJob(pool, job(), opts, {
      turn: {} as never, approvedReply: mocks.approved, transactionalDelivery: mocks.delivery,
    })).toBe('drafted');
    expect(mocks.draft).toHaveBeenCalledWith(pool, {}, expect.objectContaining({
      organizationId: 'org-1', conversationId: 'conversation-1', channelId: 'channel-1', boundary,
    }));
    expect(mocks.complete).toHaveBeenCalled();
    expect(mocks.approved).not.toHaveBeenCalled();
    expect(mocks.delivery).not.toHaveBeenCalled();
  });

  it('falha e agenda retry se a geração do rascunho retorna failed', async () => {
    (pool as { query: ReturnType<typeof vi.fn> }).query.mockResolvedValueOnce({ rows: [{
      is_group: false, contact_id: 'contact-1', channel_session_id: 'channel-1',
    }] });
    mocks.draft.mockResolvedValueOnce({ status: 'failed', original_body: '' });
    expect(await runOneAssistedJob(pool, job(), opts, {
      turn: {} as never, approvedReply: mocks.approved, transactionalDelivery: mocks.delivery,
    })).toBe('retrying');
    expect(mocks.fail).toHaveBeenCalledWith(pool, 'job-1', 'cron-1', expect.any(Error), expect.any(String));
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('cancela uma geração stale e não a reporta como rascunho pronto', async () => {
    (pool as { query: ReturnType<typeof vi.fn> }).query.mockResolvedValueOnce({ rows: [{
      is_group: false, contact_id: 'contact-1', channel_session_id: 'channel-1',
    }] });
    mocks.draft.mockResolvedValueOnce({ status: 'stale', original_body: 'texto antigo' });
    expect(await runOneAssistedJob(pool, job(), opts, {
      turn: {} as never, approvedReply: mocks.approved, transactionalDelivery: mocks.delivery,
    })).toBe('skipped');
    expect(mocks.cancel).toHaveBeenCalledWith(pool, 'job-1', 'cron-1', 'assisted_reply_draft_stale', expect.any(String));
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('não duplica uma geração que já está em andamento', async () => {
    (pool as { query: ReturnType<typeof vi.fn> }).query.mockResolvedValueOnce({ rows: [{
      is_group: false, contact_id: 'contact-1', channel_session_id: 'channel-1',
    }] });
    mocks.draft.mockResolvedValueOnce({ status: 'generating', original_body: null });
    expect(await runOneAssistedJob(pool, job(), opts, {
      turn: {} as never, approvedReply: mocks.approved, transactionalDelivery: mocks.delivery,
    })).toBe('skipped');
    expect(mocks.cancel).toHaveBeenCalledWith(pool, 'job-1', 'cron-1', 'assisted_reply_draft_generation_in_progress', expect.any(String));
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('agenda retry se pending vier sem texto', async () => {
    (pool as { query: ReturnType<typeof vi.fn> }).query.mockResolvedValueOnce({ rows: [{
      is_group: false, contact_id: 'contact-1', channel_session_id: 'channel-1',
    }] });
    mocks.draft.mockResolvedValueOnce({ status: 'pending', original_body: '  ' });
    expect(await runOneAssistedJob(pool, job(), opts, {
      turn: {} as never, approvedReply: mocks.approved, transactionalDelivery: mocks.delivery,
    })).toBe('retrying');
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('não usa o handler automático de inbound', async () => {
    (pool as { query: ReturnType<typeof vi.fn> }).query.mockResolvedValueOnce({ rows: [{
      is_group: false, contact_id: 'contact-1', channel_session_id: 'channel-1',
    }] });
    mocks.loadAgent.mockResolvedValueOnce({ operationMode: 'automatic' });
    await runOneAssistedJob(pool, job(), opts, {
      turn: {} as never, approvedReply: mocks.approved, transactionalDelivery: mocks.delivery,
    });
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalled();
  });
});
