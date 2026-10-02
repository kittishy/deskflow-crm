import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20261002090000_0502_chunks_textuais_free_only.sql', 'utf8');
const baseline = readFileSync('supabase/baseline.sql', 'utf8');
const manifest = readFileSync('supabase/migrations/MANIFEST.md', 'utf8');

describe('schema para RAG text-only', () => {
  it('versiona a coluna vetorial nullable sem apagar índices já existentes', () => {
    expect(migration).toMatch(/alter table public\.ai_chunks\s+alter column embedding drop not null;/i);
    expect(migration).not.toMatch(/update public\.ai_chunks/i);
  });

  it('leva a mesma mudança ao apêndice do baseline e registra a migration', () => {
    const bloco = baseline.split('chunks textuais para organizações free-only (migration 0502)')[1] ?? '';
    expect(bloco).toMatch(/alter table public\.ai_chunks\s+alter column embedding drop not null;/i);
    expect(manifest).toContain('| `20261002090000` | `0502_chunks_textuais_free_only` |');
  });
});
