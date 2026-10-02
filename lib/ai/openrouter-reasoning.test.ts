import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRouterFetch } from './openrouter-reasoning';

afterEach(() => vi.unstubAllEnvs());

describe('reasoning OpenRouter opt-in', () => {
  it('defaults off and leaves request body intact', async () => {
    const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'));
    const fetcher = openRouterFetch(inner as typeof fetch, 'https://openrouter.ai/api/v1');
    await fetcher('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{"temperature":0}' });
    expect(JSON.parse(String(inner.mock.calls[0]?.[1]?.body))).toEqual({ temperature: 0 });
  });

  it('sends enabled false and preserves existing reasoning fields and request fields', async () => {
    vi.stubEnv('OPENROUTER_DISABLE_REASONING', 'true');
    const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'));
    const fetcher = openRouterFetch(inner as typeof fetch, 'https://openrouter.ai/api/v1');
    await fetcher('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ temperature: 0.2, reasoning: { effort: 'low', max_tokens: 20 } }),
    });
    expect(JSON.parse(String(inner.mock.calls[0]?.[1]?.body))).toEqual({
      temperature: 0.2, reasoning: { effort: 'low', max_tokens: 20, enabled: false },
    });
  });

  it('does not change requests routed to a custom endpoint', async () => {
    vi.stubEnv('OPENROUTER_DISABLE_REASONING', 'true');
    const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'));
    const fetcher = openRouterFetch(inner as typeof fetch, 'https://gateway.example/v1');
    await fetcher('https://gateway.example/v1/chat/completions', { method: 'POST', body: '{"temperature":0}' });
    expect(JSON.parse(String(inner.mock.calls[0]?.[1]?.body))).toEqual({ temperature: 0 });
  });
});
