-- 0503 — Busca textual do acervo para organizações free-only
-- Usa o mesmo escopo de organização, fontes ativas e versão publicada da busca
-- vetorial. A ordenação é lexical; não representa similaridade vetorial.
create or replace function public.fn_buscar_trechos_textuais_das_fontes(
  p_organization_id uuid,
  p_source_ids uuid[],
  p_query text,
  p_k integer default 6
) returns table(
  chunk_id uuid,
  knowledge_source_id uuid,
  source_name text,
  content text,
  similarity real,
  metadata jsonb
)
  language plpgsql stable security definer
  set search_path to 'public'
as $$
begin
  if auth.uid() is null
     and coalesce(nullif(auth.role(), ''), nullif(current_setting('role', true), ''), '') <> 'service_role' then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'fn_buscar_trechos_textuais_das_fontes: anonymous callers are not authorized';
  end if;
  if auth.uid() is not null and not public.fn_role_at_least(p_organization_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'fn_buscar_trechos_textuais_das_fontes: caller must be an active member of the organization';
  end if;

  return query
  with query_terms as (
    select to_tsquery(
      'portuguese',
      coalesce(
        (select string_agg(quote_literal(lexeme), ' | ')
           from unnest(tsvector_to_array(to_tsvector('portuguese', p_query))) as lexeme),
        'zzemptyzz'
      )
    ) as terms
  )
  select c.id,
         c.knowledge_source_id,
         s.name,
         c.content,
         ts_rank_cd(to_tsvector('portuguese', c.content), query_terms.terms)::real,
         c.metadata
    from public.ai_chunks c
    join public.ai_knowledge_sources s
      on s.id = c.knowledge_source_id
     and s.organization_id = c.organization_id
    cross join query_terms
   where c.organization_id = p_organization_id
     and s.id = any(p_source_ids)
     and s.is_active
     and s.status = 'ready'
     and c.kb_version_id = s.active_kb_version_id
     and to_tsvector('portuguese', c.content) @@ query_terms.terms
   order by ts_rank_cd(to_tsvector('portuguese', c.content), query_terms.terms) desc,
            c.position asc
   limit greatest(least(p_k, 20), 0);
end $$;

comment on function public.fn_buscar_trechos_textuais_das_fontes(uuid, uuid[], text, integer) is
  'Busca lexical em português para chunks text-only: tenant/source/version scoped, membership checked, ordenada por relevância textual.';

revoke execute on function public.fn_buscar_trechos_textuais_das_fontes(uuid, uuid[], text, integer) from public, anon;
grant execute on function public.fn_buscar_trechos_textuais_das_fontes(uuid, uuid[], text, integer) to authenticated, service_role;
