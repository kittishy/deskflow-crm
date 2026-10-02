import { describe, expect, it, vi } from 'vitest';

const insertedRows = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { version_number: 2 }, error: null }) }) }),
          }),
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        insertedRows.rows.push(row);
        return { select: () => ({ single: async () => ({ data: { id: 'v-3', version_number: 3 }, error: null }) }) };
      },
    }),
  }),
}));

import { createKnowledgeVersion } from './version';

describe('versões text-only', () => {
  it('persiste dimensões zero e marcador text-only sem inventar vetor', async () => {
    insertedRows.rows = [];
    await createKnowledgeVersion({
      organizationId: 'org-1', knowledgeSourceId: 'source-1', agentId: null,
      sourceType: 'documento', embeddingModel: 'text-only', embeddingDims: 0,
    });
    expect(insertedRows.rows[0]).toMatchObject({
      embedding_model: 'text-only', embedding_dims: 0, status: 'building',
    });
  });

  it('mantém 1536 dimensões para indexação vetorial existente', async () => {
    insertedRows.rows = [];
    await createKnowledgeVersion({
      organizationId: 'org-1', knowledgeSourceId: 'source-1', agentId: null,
      sourceType: 'documento', embeddingModel: 'openai/text-embedding-3-small',
    });
    expect(insertedRows.rows[0]?.['embedding_dims']).toBe(1536);
  });
});
