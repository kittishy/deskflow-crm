const OPENROUTER_CANONICAL_ENDPOINT = 'https://openrouter.ai/api/v1';

/** Opt-in that suppresses reasoning only for the canonical OpenRouter API. */
export function openRouterFetch(inner: typeof fetch, endpoint: string): typeof fetch {
  if (process.env.OPENROUTER_DISABLE_REASONING !== 'true' || endpoint !== OPENROUTER_CANONICAL_ENDPOINT) {
    return inner;
  }
  return (input, init) => {
    if (typeof init?.body !== 'string') return inner(input, init);
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const existing = body.reasoning !== null && typeof body.reasoning === 'object'
        ? body.reasoning as Record<string, unknown>
        : {};
      return inner(input, {
        ...init,
        body: JSON.stringify({ ...body, reasoning: { ...existing, enabled: false } }),
      });
    } catch {
      return inner(input, init);
    }
  };
}
