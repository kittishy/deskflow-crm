-- ============================================================================
-- 2026-10-05 — 0555: AS RESPOSTAS DE SATISFAÇÃO (o NPS por atendimento)
-- manifest: tabela nps_respostas (uma linha por conversa perguntada) + fn_nps_respostas de agregado, sem FK em conversation_id de propósito.
--
-- A pergunta "como foi?" já tinha lugar natural na conversa e nenhuma linha:
-- nada media, nada comparava, nada voltava para a equipe. Esta tabela é onde a
-- resposta mora — uma linha por CONVERSA perguntada, com a nota, o comentário e
-- os dois instantes que sustentam a leitura: quando foi perguntada e quando foi
-- respondida.
--
-- Por que uma tabela e não uma coluna em `conversations`: o agregado é por
-- ORGANIZAÇÃO e por PERÍODO, e a vazão de leitura é o oposto da escrita (uma
-- pergunta a cada atendimento fechado, uma leitura do acumulado por semana).
-- Columnar em `conversations` obrigaria a varrer a inbox inteira para somar
-- satisfação.
--
-- ⚠️ A LINHA NASCE ANTES DA RESPOSTA.
--
-- `asked_at` é `not null` e `answered_at`/`score` começam nulos: o convite é
-- enviado com o token na URL, e é a existência da linha que garante a unicidade
-- (índice único abaixo). Uma tabela que só guarda quem respondeu deixa a mesma
-- pessoa receber o convite a cada rodada do cron — que é o que aconteceria se a
-- verificação fosse "existe resposta?" em vez de "existe convite?".
--
-- ⚠️ `conversation_id` NÃO tem FK, e é deliberado.
--
-- O NPS é uma medida de operação. Se a retenção apagar a conversa, a nota tem
-- de continuar contando — com FK `on delete cascade` o número mudaria para
-- baixo DEPOIS, sem ninguém ter recebido atendimento pior, e a leitura do mês
-- seguinte contradiria a do mês passado. Mesma decisão de `jev_observacoes`
-- (0421), que é ponteiro por escolha e não por esquecimento.
--
-- Já `contact_id` tem FK com `on delete set null`: aqui o vínculo é uma
-- identidade de PESSOA, e apagar o contato tem de apagar a referência sem levar
-- a medida junto. E é ele que paga o cooldown de 90 dias.
--
-- Idempotente: `create ... if not exists`, index único/por policy
-- `drop if exists` + `create`, função `create or replace`, grants reemitidos.
-- Função nova em `public`: revogada das DUAS origens (`public` e `anon`) e de
-- `authenticated`, e devolvida a `authenticated` e `service_role` — só quem já
-- tem sessão da organização chega nela (item 9 da doutrina de migrations).
-- ============================================================================

create table if not exists public.nps_responses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- A pergunta é sobre UM atendimento. `not null`: sem conversa não há o que
  -- perguntar, e uma linha sem assunto não entra em nenhuma média.
  conversation_id uuid not null,
  -- Ver o cabeçalho: ponteiro com `on delete set null`.
  contact_id uuid references public.contacts(id) on delete set null,
  -- O convite público. É a ÚNICA credencial de quem responde: a rota
  -- `/api/v1/nps/[token]` resolve a organização por ESTA LINHA e nunca pelo
  -- caminho, então o token precisa ser indevassível — `gen_random_uuid()` é o
  -- mesmo segredo do `id`, sem herança nenhuma.
  token uuid not null default gen_random_uuid(),
  -- A NOTA, não o rótulo. Quem decide "promotor" é a conta
  -- (`lib/nps/agregado.ts` e `fn_nps_respostas`), em um lugar só.
  score smallint,
  -- Texto livre do cliente: commentário sobre o atendimento.
  comment text,
  -- Quando o convite saiu. `not null`: a linha nasce no disparo.
  asked_at timestamptz not null default now(),
  -- Quando alguém respondeu.
  answered_at timestamptz,
  constraint nps_responses_score_check check (score is null or (score >= 0 and score <= 10)),
  -- O teto é o mesmo do Zod da rota pública (`lib/schemas` do consumer):
  -- deixar o banco aceitar um comentário de 1 MB faria a tela da equipe
  -- carregar um documento inteiro.
  constraint nps_responses_comment_check check (comment is null or char_length(comment) <= 1000),
  -- Nota e resposta NASCEM ou MORREM juntas. `answered_at` sem `score` produz um
  -- "respondeu" que o agregado contaria como não respondido, e `score` sem
  -- `answered_at` contaria na média sem data para o gráfico.
  constraint nps_responses_resposta_check check ((score is null) = (answered_at is null))
);

comment on table public.nps_responses is
  'Uma linha por CONVERSA perguntada: o convite (asked_at, token) e a resposta (score, comment, answered_at). Ponteiro de conversa SEM FK para a medida não sumir quando a conversa for apagada. Escrita só pelo servidor (cron nps-dispatch e a rota pública, via service role); lida por qualquer membro da organização (fn_nps_respostas).';

-- A pergunta uma vez por conversa. É a rede do cron: duas rodadas simultâneas
-- (ou o retry de uma) perguntam duas vezes sem isto, e a pessoa
-- recebe o mesmo link duplicado.
create unique index if not exists nps_responses_uma_por_conversa_idx
  on public.nps_responses (organization_id, conversation_id);

-- O convite é o token da rota pública: precisa ser ÚNICO para o `maybeSingle()`
-- dela responder uma linha, e precisa de índice próprio porque a busca é por
-- token e nenhuma outra consulta deste cron usa essa coluna.
create unique index if not exists nps_responses_token_idx
  on public.nps_responses (token);

-- "Quem já foi perguntado" e o acumulado da organização, na ordem do tempo.
create index if not exists nps_responses_org_perguntada_idx
  on public.nps_responses (organization_id, asked_at desc);

-- O cooldown de 90 dias é uma consulta por CONTATO com o instante da última
-- pergunta; sem este índice ela varre a resposta inteira da organização.
create index if not exists nps_responses_org_contato_idx
  on public.nps_responses (organization_id, contact_id, asked_at desc)
  where contact_id is not null;

-- Leitura por qualquer membro da organização (é medição de atendimento, não
-- dado de pessoa para leitura). Escrita só do servidor, que passa por cima da RLS.
-- Sem policy ALL: `authenticated` não tem por que escrever aqui.
alter table public.nps_responses enable row level security;
drop policy if exists tenant_isolation_nps_responses_select on public.nps_responses;
create policy tenant_isolation_nps_responses_select on public.nps_responses
  for select using (organization_id in (select public.fn_user_org_ids()));

-- O ALTER DEFAULT PRIVILEGES do baseline dá GRANT ALL em TABLES a `anon`: toda
-- tabela nova nasce exposta e revoga por conta própria.
revoke all on public.nps_responses from anon, authenticated;
grant select on public.nps_responses to authenticated;
grant all on public.nps_responses to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- fn_nps_respostas — a MESMA conta de `lib/nps/agregado.ts`, no servidor.
--
-- Por que duplicar a matemática em SQL: agregar no Node traz toda a resposta da
-- organização pela rede para somar em JavaScript — numa VPS de 2 GB é o que
-- derruba o banco. E por que isto NÃO é uma segunda regra: a faixa (9-10 / 7-8 /
-- 0-6), a amostra mínima (5) e o arredondamento estão escritos nos dois lugares
-- com o mesmo porquê; o TypeScript é a legível, esta função é a que roda.
--
-- `security invoker` (o default): a RLS da tabela decide quem vê, e a checagem
-- não é uma segunda paralela que possa divergir da primeira. Um `security
-- definer` "para facilitar" leria a resposta de outra organização por `p_org`
-- escrito à mão — vazamento entre inquilinos.
--
-- `nps` sai NULL abaixo de 5 respostas: `-100` de uma resposta é artefato da
-- amostra, e um painel que mostra "-100" desliga um canal inteiro por causa de
-- um cliente que respondeu mal. `taxa_de_resposta` usa `perguntadas`, que
-- inclui as linhas sem nota — é a diferença entre "ninguém respondeu" e
-- "ninguém foi perguntado".
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.fn_nps_respostas(
  p_org uuid,
  p_desde timestamptz default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with janela as (
    select n.score
    from public.nps_responses n
    where n.organization_id = p_org
      and (p_desde is null or n.asked_at >= p_desde)
  ),
  contagens as (
    select
      count(*)::int as perguntadas,
      count(*) filter (where w.score is not null)::int as respondidas,
      count(*) filter (where w.score between 9 and 10)::int as promotores,
      count(*) filter (where w.score between 7 and 8)::int as neutros,
      count(*) filter (where w.score between 0 and 6)::int as detratores,
      -- Fora de 0..10 nunca deveria existir (CHECK), e é por isso que a conta
      -- aparece: um zero aqui é sinal de defeito, não de cliente.
      count(*) filter (where w.score is not null and (w.score < 0 or w.score > 10))::int as descartadas,
      max(w.answered_at) as ultima_resposta_em
    from janela w
  )
  select jsonb_build_object(
    'perguntadas', c.perguntadas,
    'respondidas', c.respondidas,
    'promotores', c.promotores,
    'neutros', c.neutros,
    'detratores', c.detratores,
    'descartadas', c.descartadas,
    'nps', case
      when c.respondidas < 5 then null
      else round(((c.promotores - c.detratores)::numeric / c.respondidas) * 100)
    end,
    'taxa_de_resposta', case
      when c.perguntadas = 0 then 0
      else round((c.respondidas::numeric / c.perguntadas) * 10000) / 100
    end,
    'ultima_resposta_em', c.ultima_resposta_em
  )
  from contagens c;
$$;

-- Função nova em `public` nasce EXPOSTA por DUAS origens (doutrina de migrations
-- §9): o `GRANT ALL ON FUNCTIONS TO anon` do baseline e o grant a PUBLIC que o
-- Postgres dá a toda função. Tratar só uma deixa a RPC alcançável pela anon key,
-- que vai para o browser.
revoke all on function public.fn_nps_respostas(uuid, timestamptz) from public;
revoke execute on function public.fn_nps_respostas(uuid, timestamptz) from anon;
grant execute on function public.fn_nps_respostas(uuid, timestamptz)
  to authenticated, service_role;