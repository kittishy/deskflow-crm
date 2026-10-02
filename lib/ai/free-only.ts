/** Allowlist de organizações que só podem usar modelos OpenRouter gratuitos. */
export function freeOnlyForOrganization(organizationId: string): boolean {
  return (process.env.AI_FREE_ONLY_ORGANIZATION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(organizationId);
}

export class AiFreeOnlyError extends Error {
  readonly code = 'ai_free_only';
  constructor() {
    super('ai_free_only: esta organização está configurada para usar somente modelos gratuitos da OpenRouter.');
    this.name = 'AiFreeOnlyError';
  }
}

export function assertFreeModel(
  organizationId: string,
  provider: string,
  model: string,
  baseUrl?: string | null,
): void {
  if (!freeOnlyForOrganization(organizationId)) return;
  const endpoint = baseUrl ?? process.env.OPENROUTER_BASE_URL?.trim() ?? 'https://openrouter.ai/api/v1';
  if (
    provider !== 'openrouter' ||
    !model.endsWith(':free') ||
    endpoint !== 'https://openrouter.ai/api/v1'
  ) {
    throw new AiFreeOnlyError();
  }
}
