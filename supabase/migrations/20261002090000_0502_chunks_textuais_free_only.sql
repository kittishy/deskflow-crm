-- 0502 — Chunks textuais para organizações free-only
-- `embedding` permanece preenchido para índices vetoriais e pode ser NULL
-- somente nos índices marcados `text-only` em `ai_knowledge_versions`.
-- A consulta free-only usa PostgreSQL full-text search com escopo tenant/source.
alter table public.ai_chunks
  alter column embedding drop not null;

comment on column public.ai_chunks.embedding is
  'Vetor do chunk quando a versão usa busca vetorial; NULL para versões text-only (embedding_model=text-only), consultadas por full-text search.';
