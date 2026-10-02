import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertFreeModel, freeOnlyForOrganization } from './free-only';
afterEach(() => vi.unstubAllEnvs());
describe('free-only por organizacao', () => {
  it('default preserva outras organizacoes', () => {
    vi.stubEnv('AI_FREE_ONLY_ORGANIZATION_IDS', '');
    expect(freeOnlyForOrganization('org')).toBe(false);
    expect(() => assertFreeModel('org', 'anthropic', 'paid')).not.toThrow();
  });
  it('exige correspondencia completa', () => {
    vi.stubEnv('AI_FREE_ONLY_ORGANIZATION_IDS', ' org-a, org-b ');
    expect(freeOnlyForOrganization('org')).toBe(false);
    expect(freeOnlyForOrganization('org-a')).toBe(true);
  });
  it.each([
    ['openrouter', 'qwen/model', undefined],
    ['anthropic', 'qwen/model:free', undefined],
    ['openrouter', 'qwen/model:free', 'https://other.example/v1'],
  ])('bloqueia %s %s %s', (provider, model, url) => {
    vi.stubEnv('AI_FREE_ONLY_ORGANIZATION_IDS', 'org');
    expect(() => assertFreeModel('org', provider!, model!, url)).toThrow('ai_free_only');
  });
  it('permite rota gratuita canonica', () => {
    vi.stubEnv('AI_FREE_ONLY_ORGANIZATION_IDS', 'org');
    vi.stubEnv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1');
    expect(() => assertFreeModel('org', 'openrouter', 'qwen/model:free')).not.toThrow();
  });
  it('nega baseURL de instalação customizada mesmo sem baseURL no binding', () => {
    vi.stubEnv('AI_FREE_ONLY_ORGANIZATION_IDS', 'org');
    vi.stubEnv('OPENROUTER_BASE_URL', 'https://gateway.example/v1');
    expect(() => assertFreeModel('org', 'openrouter', 'qwen/model:free')).toThrow('ai_free_only');
  });
});
