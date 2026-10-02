/** Allowlist de organizações que só podem usar modelos OpenRouter gratuitos. */
export function freeOnlyForOrganization(organizationId: string): boolean {
  return (process.env.AI_FREE_ONLY_ORGANIZATION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(organizationId);
}

/** Modelos Zen que são gratuitos e cujo provedor declara zero retenção e sem treinamento. */
export const OPENCODE_ZEN_FREE_MODELS = [
  'space-bunny-free',
  'longcat-2.5-preview-free',
] as const;
/** Único modelo utilizado na conta Free da Groq; os outros IDs do catálogo são bloqueados. */
export const GROQ_FREE_MODELS = ['openai/gpt-oss-120b'] as const;

export class AiFreeOnlyError extends Error {
  readonly code = 'ai_free_only';
  constructor() {
    super('ai_free_only: esta organização está configurada para usar somente modelos gratuitos autorizados.');
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
  if (provider === 'openrouter') {
    const endpoint = baseUrl ?? (process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1');
    if (model.endsWith(':free') && endpoint === 'https://openrouter.ai/api/v1') return;
  }
  if (provider === 'opencode') {
    const endpoint = baseUrl ?? 'https://opencode.ai/zen/v1';
    const modelId = model.startsWith('opencode/') ? model.slice('opencode/'.length) : model;
    if (
      OPENCODE_ZEN_FREE_MODELS.some((id) => id === modelId) &&
      endpoint === 'https://opencode.ai/zen/v1'
    ) return;
  }
  if (provider === 'groq') {
    const endpoint = baseUrl ?? 'https://api.groq.com/openai/v1';
    if (
      GROQ_FREE_MODELS.some((id) => id === model) &&
      endpoint === 'https://api.groq.com/openai/v1'
    ) return;
  }
  throw new AiFreeOnlyError();
}
