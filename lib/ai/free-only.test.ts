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
  it('usa o endpoint oficial quando OPENROUTER_BASE_URL está vazio', () => {
    vi.stubEnv('AI_FREE_ONLY_ORGANIZATION_IDS', 'org');
    vi.stubEnv('OPENROUTER_BASE_URL', '');
    expect(() => assertFreeModel('org', 'openrouter', 'qwen/model:free')).not.toThrow();
  });
  it('permite apenas modelos gratuitos de chat sem retencao do OpenCode Zen', () => {
    vi.stubEnv('AI_FREE_ONLY_ORGANIZATION_IDS', 'org');
    expect(() => assertFreeModel('org', 'opencode', 'space-bunny-free')).not.toThrow();
    expect(() => assertFreeModel('org', 'opencode', 'longcat-2.5-preview-free')).not.toThrow();
  });
  it('permite Groq Free somente no GPT-OSS 120B e endpoint oficial', () => {
    vi.stubEnv('AI_FREE_ONLY_ORGANIZATION_IDS', 'org');
    expect(() => assertFreeModel('org', 'groq', 'openai/gpt-oss-120b')).not.toThrow();
  });
  it.each([
    ['opencode', 'muse-spark-1.3-contributor-free', undefined],
    ['opencode', 'nemotron-3-ultra-free', undefined],
    ['opencode', 'space-bunny-free', 'https://evil.example/v1'],
    ['opencode', 'gpt-5.6-sol', undefined],
    ['groq', 'openai/gpt-oss-20b', undefined],
    ['groq', 'openai/gpt-oss-120b', 'https://api.openai.com/v1'],
  ])('bloqueia OpenCode que pode treinar, restringe dado pessoal ou custa: %s %s', (provider, model, url) => {
    vi.stubEnv('AI_FREE_ONLY_ORGANIZATION_IDS', 'org');
    expect(() => assertFreeModel('org', provider!, model!, url)).toThrow('ai_free_only');
  });
  it('nega baseURL de instalação customizada mesmo sem baseURL no binding', () => {
    vi.stubEnv('AI_FREE_ONLY_ORGANIZATION_IDS', 'org');
    vi.stubEnv('OPENROUTER_BASE_URL', 'https://gateway.example/v1');
    expect(() => assertFreeModel('org', 'openrouter', 'qwen/model:free')).toThrow('ai_free_only');
  });
});
