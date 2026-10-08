-- ============================================================================
-- 0564: A FILA DE ENVIO INTERVALADO (message_send_queue)
-- manifest: fila de envio manual por contato, com ritmo configurável, prioridade, pausa por resposta e processamento sem duplicidade.
--
-- ─── O QUE É ─────────────────────────────────────────────────────────────────
--
-- Uma mensagem escrita por um HUMANO para UM contato, esperando a vez dela sair.
-- Não é disparo em massa, não é campanha, não é fila do agente: o texto é de
-- uma pessoa, para uma pessoa. A fila existe só para o INTERVALO entre
-- contatos diferentes — quando alguém responde cinco contatos seguidos num
-- atendimento, as mensagens saem com respiro em vez de todas de uma vez.
--
-- ─── POR QUE UMA TABELA NOVA, E NÃO COLUNAS EM `messages` ────────────────────
--
-- `messages` é o log de mensagens: o inbox, o MCP, o histórico do atendimento,
-- a exportação de LGPD e as invariantes de banco leem essa tabela. O estado de
-- uma fila é outra coisa — agenda, prioridade, quem travou, quantas tentativas.
-- Enfiar isso em `messages` transformaria o log de leitura em fila de trabalho
-- e cada consulta do inbox passaria a carregar colunas que não são dela.
--
-- A divisão é: o TEXTO mora em `messages` (uma linha só, criada no clique, como
-- hoje) e o TRABALHO mora aqui. Editar a mensagem pendente atualiza
-- `messages.body` e marca `editada_em` — nunca cria uma segunda linha.
--
-- ─── SEGURANÇA ───────────────────────────────────────────────────────────────
--
-- RLS: o client de sessão (authenticated) só LÊ a fila. Toda mutação de status
-- passa por RPC service-role — um client de sessão não pode marcar item como
-- `sent` nem `cancelled` direto. As funções de ciclo de vida são
-- `security definer` e têm `execute` revogado de public/anon/authenticated.
-- ============================================================================

create table if not exists public.message_send_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- A mensagem já existe em `messages` desde o clique. `cascade` porque quem
  -- apaga a mensagem (LGPD, moderacao) não pode deixar trabalho órfão na fila.
  message_id uuid not null references public.messages(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,

  -- Resposta / conversa ativa / follow-up / nova abordagem. É a ordem da fila
  -- (ver `lib/messaging/fila/classificacao.ts`); o texto de `messages.type` é
  -- outro eixo (text/template/media) e não serve para isto.
  tipo text not null check (tipo in ('resposta','conversa_ativa','follow_up','prospeccao')),
  status text not null default 'pending'
    check (status in ('pending','processing','sent','paused','cancelled','failed')),
  -- Menor número sai primeiro. Espelha PRIORIDADE em classificacao.ts; a
  -- denormalização é deliberada, porque o `order by` da reivindicação acontece
  -- no Postgres e não pode chamar TypeScript.
  prioridade smallint not null default 30,

  scheduled_at timestamptz not null,
  tentativas smallint not null default 0,
  max_tentativas smallint not null default 3,
  locked_by text,
  locked_at timestamptz,
  -- Fencing: cada claim gera um token novo; a conclusão exige o MESMO token.
  -- Um worker atrasado que tenta fechar um item já re-claimado por outro
  -- recebe zero linhas — não sobrescreve o estado do dono novo.
  claim_token uuid,

  -- Snapshot imutável do claim: o corpo e o tipo no instante da reivindicação.
  -- O worker envia o snapshot, não o corpo vivo — uma edição concorrente não
  -- muda o que está sendo enviado sem passar pelo recheck do sink.
  snapshot_body text,
  snapshot_tipo text,

  enviado_em timestamptz,
  pausado_em timestamptz,
  pausado_motivo text,
  cancelado_em timestamptz,
  falho_em timestamptz,
  -- NUNCA o texto da mensagem nem dado do contato. É o erro da integração,
  -- truncado no código — o mesmo contrato de `job_queue.last_error`.
  erro text,
  editada_em timestamptz,

  criado_por_user_id uuid,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  -- Uma fila por mensagem. É o que garante que editar não duplique e que
  -- "enviar agora" não crie uma segunda linha para o mesmo texto.
  unique (organization_id, message_id)
);

-- A ordem do worker inteiro: o que está pronto primeiro, na prioridade, e na
-- ordem em que foi agendado. Parcial porque só `pending` compete.
create index if not exists idx_fila_envio_reivindicar
  on public.message_send_queue (scheduled_at, prioridade, criado_em)
  where status = 'pending';

-- "Tem algo esperando este contato?" — a leitura da pausa por resposta e a do
-- painel da fila. Parcial nos status que ainda podem virar envio.
create index if not exists idx_fila_envio_contato
  on public.message_send_queue (organization_id, contact_id, status)
  where status in ('pending','processing','paused');

-- O badge "Fila de envio: N mensagens" e o teto diário de prospecção contam por
-- organização e por dia.
create index if not exists idx_fila_envio_org
  on public.message_send_queue (organization_id, criado_em desc);

-- Single-flight por remetente: no máximo UM item `processing` por sessão de
-- canal. O índice parcial torna a checagem do claim barata.
create unique index if not exists idx_fila_envio_um_processing_por_sessao
  on public.message_send_queue (channel_session_id)
  where status = 'processing';

alter table public.message_send_queue enable row level security;

-- O client de sessão SÓ LÊ. Mutação de status é RPC service-role.
drop policy if exists tenant_isolation_fila_envio_all on public.message_send_queue;
drop policy if exists tenant_isolation_fila_envio_select on public.message_send_queue;
create policy tenant_isolation_fila_envio_select on public.message_send_queue
  for select
  using (organization_id in (select * from public.fn_user_org_ids()));

revoke all on public.message_send_queue from anon;
revoke insert, update, delete on public.message_send_queue from authenticated;

comment on table public.message_send_queue is
  'Fila de envio manual por contato: uma mensagem escrita por uma pessoa, esperando a vez dela respeitar o intervalo configurado. O texto mora em messages; aqui mora o trabalho (agenda, prioridade, tentativa, erro). Não é campanha, não é disparo em massa, e não substitui pacing_ledger, que é a regra de verdade do canal.';
comment on column public.message_send_queue.tipo is
  'resposta | conversa_ativa | follow_up | prospeccao. Ordem da fila: a resposta de quem está esperando sai antes de tudo.';
comment on column public.message_send_queue.scheduled_at is
  'Instante estimado de saída, no segundo. Sempre depois do fim da cadeia (último envio a outro contato e maior horário já ocupado), o que impede horário repetido.';
comment on column public.message_send_queue.erro is
  'Erro da integração, truncado. Nunca o texto da mensagem nem dado do contato.';
comment on column public.message_send_queue.claim_token is
  'Fencing do claim: a conclusão exige o mesmo token. Um worker atrasado não sobrescreve o dono novo.';
comment on column public.message_send_queue.snapshot_body is
  'Corpo da mensagem no instante do claim. Imutável: o worker envia o snapshot, não o corpo vivo.';

-- ─── PAUSAR QUANDO O CONTATO RESPONDE ────────────────────────────────────────
--
-- Uma mensagem antiga não pode sair depois que a pessoa respondeu: ela responde
-- a uma pergunta que já foi resolvida. A regra é a mais importante do pedido, e
-- por isso mora no banco — vale para WAHA, Meta e Zernio sem depender de
-- nenhum ingestion lembrar de avisar.
--
-- `settings->>'ritmo_envio'->>'pausar_se_contato_respondeu'` respeita a
-- configuração da organização: desligado, ninguém pausa.
--
-- Fail-closed: qualquer erro (settings malformado, linha de org sumida) PAUSA
-- em vez de deixar a mensagem sair — e NUNCA derruba o insert da mensagem
-- inbound. Um webhook duplicado antigo (created_at velho) não pausa nada.

-- A função e o trigger ficam no FIM do arquivo, depois de todas as outras
-- funções da fila: `create trigger ... execute function` exige que a função já
-- exista, e o Postgres nãozdá "use a versão de depois".

-- ─── ADMISSÃO ATÔMICA ────────────────────────────────────────────────────────
--
-- Uma transação só, com lock de transação por (organização, sessão de canal):
-- quota diária + cálculo de horário + reflow + insert. Sem isso, duas
-- admissões concorrentes reservam o mesmo slot e estouram o teto do dia.
--
-- O reflow reordena os pendentes por (prioridade, criado_em) e reatribui
-- slots a partir do fim da cadeia — a ordem da tela (prioridade, horário)
-- passa a concordar com a ordem real de saída.

-- O `revoke`/`grant`/`comment` destas duas fica no FIM do arquivo, junto das
-- demais funções: um `revoke ... from anon` numa função que ainda não foi criada
-- aborta a migration inteira.

-- ─── A REIVINDICAÇÃO PRECISA SER FUNÇÃO, E NÃO UM `update` DO POSTGREST ────────
--
-- Duas coisas que só o banco faz e o PostgREST não:
--
--   1. `for update skip locked` — a fila é disputada por N workers. O `skip
--      locked` faz cada um pegar o PRÓXIMO item livre em vez de travar no
--      primeiro; combinado com o `for update`, dois workers nunca pegam a mesma
--      linha. Sem isso, era preciso `pg_advisory_lock`, que o PostgREST não
--      oferece (é a mesma limitação que `lib/messaging/ritmo-do-envio-por-token.ts`
--      registra sobre o `pacing_ledger`).
--   2. `tentativas = tentativas + 1` — o PostgREST grava valor literal, não
--      expressão. Sem isto, o contador de tentativas ou fica sempre em 1 (e o
--      retry vira laço) ou exige ler-e-depois-escrever (e volta a ser corrida).
--
-- Single-flight por remetente: o índice único parcial
-- `idx_fila_envio_um_processing_por_sessao` garante no máximo UM item
-- `processing` por sessão de canal — um segundo claim na mesma sessão falha
-- com violação de unicidade, e o worker tenta o próximo item.
--
-- Tudo numa transação só: ou o worker recebe o item já `processing`, ou não
-- recebe nada.

-- `revoke`/`grant`/`comment` de `fn_fila_envio_reivindicar`: no fim do arquivo.

-- Dispatch authorization is a linearization point. Once the provider request
-- starts it cannot be recalled; unknown outcomes must never be replayed blindly.
alter table public.message_send_queue
  add column if not exists intervalo_s integer not null default 90,
  add column if not exists forcar_envio boolean not null default false,
  add column if not exists dispatch_started_at timestamptz;
grant select on public.message_send_queue to authenticated;
grant all on public.message_send_queue to service_role;
revoke truncate, references, trigger on public.message_send_queue from authenticated;

create or replace function public.fn_fila_envio_sincronizar()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.messages m set metadata = coalesce(m.metadata, '{}'::jsonb) ||
    jsonb_build_object('fila_envio', jsonb_build_object(
      'id',new.id,'status',new.status,'scheduled_at',new.scheduled_at,
      'tipo',new.tipo,'motivo',new.pausado_motivo,'erro',new.erro)),
    updated_at = now()
  where m.id = new.message_id and m.organization_id = new.organization_id;
  return new;
end;
$$;
drop trigger if exists trg_fila_envio_sincronizar on public.message_send_queue;
create trigger trg_fila_envio_sincronizar after insert or update on public.message_send_queue
  for each row execute function public.fn_fila_envio_sincronizar();

create or replace function public.fn_fila_envio_reordenar(p_org uuid,p_canal uuid,p_agora timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_contato uuid; v_cursor timestamptz; v_config jsonb;
  v_priorizar boolean; r public.message_send_queue;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_canal::text,0));
  select settings->'ritmo_envio' into v_config from public.organizations where id=p_org;
  v_priorizar := coalesce(v_config->>'priorizar_conversas_ativas','true') <> 'false';
  select q.contact_id,coalesce(q.enviado_em,q.dispatch_started_at,q.locked_at)
    into v_contato,v_cursor from public.message_send_queue q
    where q.organization_id=p_org and q.channel_session_id=p_canal
      and q.status in ('sent','processing')
    order by coalesce(q.enviado_em,q.dispatch_started_at,q.locked_at) desc limit 1;
  if v_cursor is null then
    select m.contact_id,m.sent_at into v_contato,v_cursor from public.messages m
      where m.organization_id=p_org and m.channel_session_id=p_canal
        and m.direction='outbound' and m.status in ('sent','delivered','read')
      order by m.sent_at desc limit 1;
  end if;
  for r in select q.* from public.message_send_queue q
    where q.organization_id=p_org and q.channel_session_id=p_canal and q.status='pending'
    order by q.forcar_envio desc,case when v_priorizar then q.prioridade else 0 end,q.criado_em,q.id
  loop
    if r.forcar_envio then v_cursor:=p_agora;
    elsif v_cursor is null then v_cursor:=p_agora;
    elsif v_contato=r.contact_id then v_cursor:=greatest(p_agora,v_cursor);
    else v_cursor:=greatest(p_agora,v_cursor+make_interval(secs=>r.intervalo_s));
    end if;
    update public.message_send_queue set scheduled_at=v_cursor,atualizado_em=now() where id=r.id;
    v_contato:=r.contact_id;
  end loop;
end;
$$;

create or replace function public.fn_fila_envio_admitir(
  p_organization_id uuid,p_message_id uuid,p_contact_id uuid,p_conversation_id uuid,
  p_channel_session_id uuid,p_tipo text,p_prioridade smallint,p_agora timestamptz,
  p_intervalo_minimo_s integer,p_intervalo_maximo_s integer,p_limite_diario integer,
  p_criado_por_user_id uuid)
returns public.message_send_queue language plpgsql security definer set search_path=public as $$
declare
  v_item public.message_send_queue; v_usadas integer; v_tz text;
  v_min integer:=greatest(0,p_intervalo_minimo_s);
  v_max integer:=greatest(v_min,p_intervalo_maximo_s);
  v_pausado boolean:=false;
begin
  -- Organization lock also serializes daily admissions across multiple senders.
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_channel_session_id::text,0));
  if not public.fn_org_operante(p_organization_id) then raise exception 'org_suspended'; end if;
  select * into v_item from public.message_send_queue where organization_id=p_organization_id and message_id=p_message_id;
  if found then return v_item; end if;
  if not exists(select 1 from public.messages m join public.conversations c on c.id=m.conversation_id
    join public.contacts ct on ct.id=m.contact_id join public.channel_sessions cs on cs.id=m.channel_session_id
    where m.id=p_message_id and m.organization_id=p_organization_id and c.organization_id=p_organization_id
      and ct.organization_id=p_organization_id and cs.organization_id=p_organization_id
      and m.contact_id=p_contact_id and m.conversation_id=p_conversation_id
      and m.channel_session_id=p_channel_session_id and m.direction='outbound' and m.status='queued')
  then raise exception 'queue_message_identity_mismatch'; end if;
  select timezone into v_tz from public.organizations where id=p_organization_id;
  if p_tipo='prospeccao' and p_limite_diario>0 then
    select count(*) into v_usadas from public.message_send_queue q
      where q.organization_id=p_organization_id and q.tipo='prospeccao'
        and (q.status in ('pending','processing') or
          (q.status='sent' and (q.enviado_em at time zone v_tz)::date=(p_agora at time zone v_tz)::date));
    v_pausado:=v_usadas>=p_limite_diario;
  end if;
  insert into public.message_send_queue(organization_id,message_id,contact_id,conversation_id,
    channel_session_id,tipo,prioridade,status,scheduled_at,criado_por_user_id,intervalo_s,
    pausado_motivo,pausado_em)
  values(p_organization_id,p_message_id,p_contact_id,p_conversation_id,p_channel_session_id,
    p_tipo,p_prioridade,case when v_pausado then 'paused' else 'pending' end,p_agora,
    p_criado_por_user_id,v_min+floor(random()*(v_max-v_min+1))::integer,
    case when v_pausado then 'limite_diario_de_abordagens' end,case when v_pausado then p_agora end)
  returning * into v_item;
  perform public.fn_fila_envio_reordenar(p_organization_id,p_channel_session_id,p_agora);
  select * into v_item from public.message_send_queue where id=v_item.id;
  return v_item;
end;
$$;

create or replace function public.fn_fila_envio_reivindicar(p_worker text,p_agora timestamptz)
returns setof public.message_send_queue language plpgsql security definer set search_path=public as $$
declare c record; r public.message_send_queue;
begin
  for c in select distinct organization_id,channel_session_id from public.message_send_queue
    where status='pending' and public.fn_org_operante(organization_id)
  loop
    if not pg_try_advisory_xact_lock(hashtextextended(c.organization_id::text || ':' || c.channel_session_id::text,0)) then continue; end if;
    if exists(select 1 from public.message_send_queue where channel_session_id=c.channel_session_id and status='processing') then continue; end if;
    perform public.fn_fila_envio_reordenar(c.organization_id,c.channel_session_id,p_agora);
    select * into r from public.message_send_queue where organization_id=c.organization_id
      and channel_session_id=c.channel_session_id and status='pending' and scheduled_at<=p_agora
      order by scheduled_at,prioridade,criado_em,id for update skip locked limit 1;
    if not found then continue; end if;
    update public.message_send_queue q set status='processing',locked_by=p_worker,
      locked_at=p_agora,claim_token=gen_random_uuid(),tentativas=tentativas+1,
      snapshot_body=(select body from public.messages where id=q.message_id),snapshot_tipo=q.tipo,
      dispatch_started_at=null,atualizado_em=now() where id=r.id returning * into r;
    return next r; return;
  end loop;
end;
$$;

create or replace function public.fn_fila_envio_autorizar(p_org uuid,p_id uuid,p_token uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare r public.message_send_queue;
begin
  select * into r from public.message_send_queue where id=p_id and organization_id=p_org for update;
  if not found or r.status<>'processing' or r.claim_token is distinct from p_token then return false; end if;
  if r.dispatch_started_at is null then
    update public.message_send_queue set dispatch_started_at=clock_timestamp() where id=p_id;
  end if;
  return true;
end;
$$;

create or replace function public.fn_fila_envio_alterar(p_org uuid,p_id uuid,p_acao text,p_corpo text default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare r public.message_send_queue; v_canal uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text,0));
  select channel_session_id into v_canal from public.message_send_queue where id=p_id and organization_id=p_org;
  if not found then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || v_canal::text,0));
  select * into r from public.message_send_queue where id=p_id and organization_id=p_org for update;
  if r.status not in ('pending','paused') then return false; end if;
  if p_acao='editar' then
    if p_corpo is null or length(trim(p_corpo))=0 or length(p_corpo)>8000 then raise exception 'invalid_body'; end if;
    update public.messages set body=p_corpo,edited_at=now(),updated_at=now() where id=r.message_id and organization_id=p_org;
    update public.message_send_queue set editada_em=now(),atualizado_em=now() where id=p_id;
  elsif p_acao='cancelar' then
    update public.message_send_queue set status='cancelled',cancelado_em=now(),atualizado_em=now() where id=p_id;
  elsif p_acao='pausar' then
    update public.message_send_queue set status='paused',pausado_em=now(),pausado_motivo='pausada_pelo_usuario',atualizado_em=now() where id=p_id;
  elsif p_acao in ('retomar','enviar_agora') then
    -- A budget pause is not bypassed by send-now or resume.
    if r.pausado_motivo='limite_diario_de_abordagens' then return false; end if;
    update public.message_send_queue set status='pending',pausado_em=null,pausado_motivo=null,
      forcar_envio=(p_acao='enviar_agora'),atualizado_em=now() where id=p_id;
  else raise exception 'invalid_action'; end if;
  perform public.fn_fila_envio_reordenar(p_org,v_canal,now());
  return true;
end;
$$;

-- A DEFINIÇÃO VIVA. A anterior (o bloco logo acima, com o mesmo nome) foi
-- removida de propósito: manter duas definições do mesmo trigger num arquivo de
-- migration é armadilha — a última vence em silêncio e a primeira vira lixo que
-- ainda parece autoritativa. Esta é a soma das duas: guarda de webhook
-- duplicado, fail-closed em settings malformado, e o trigger nunca derruba o
-- insert inbound.
create or replace function public.fn_fila_envio_pausa_por_resposta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pausar boolean := true;
begin
  if new.direction is distinct from 'inbound' then
    return new;
  end if;

  -- Webhook duplicado/antigo: não pausa a fila de novo.
  if new.created_at is not null and new.created_at < now() - interval '15 minutes' then
    return new;
  end if;

  begin
    select coalesce(
             (
               select (s.settings -> 'ritmo_envio' ->> 'pausar_se_contato_respondeu')::boolean
               from public.organizations s
               where s.id = new.organization_id
             ),
             true
           )
      into v_pausar;
  exception when others then
    -- Settings malformado: fail-closed = pausa. Nunca propaga o erro.
    v_pausar := true;
  end;

  if v_pausar then
    update public.message_send_queue q
       set status          = 'paused',
           pausado_em      = now(),
           pausado_motivo  = 'contato_respondeu',
           atualizado_em   = now(),
           locked_by       = null,
           locked_at       = null,
           claim_token     = null
     where q.organization_id = new.organization_id
       and q.contact_id      = new.contact_id
       -- Só o que foi montado ANTES desta resposta. Uma resposta não pode
       -- pausar a si mesma nem as mensagens que a pessoa vai escrever depois.
       and q.criado_em      <= new.created_at
       -- Item cujo dispatch já começou não é mais pausável: o pedido ao
       -- provedor está no ar e revogá-lo aqui só criaria divergência entre
       -- a fila e o que o WhatsApp realmente recebeu.
       and q.dispatch_started_at is null
       and q.status          in ('pending', 'processing');
  end if;

  return new;
exception when others then
  -- O trigger NUNCA pode derrubar o insert da mensagem inbound: um erro aqui
  -- perderia a mensagem do cliente na hora em que ela chegou.
  return new;
end;
$$;

revoke execute on function public.fn_fila_envio_pausa_por_resposta() from public, anon, authenticated;
grant execute on function public.fn_fila_envio_pausa_por_resposta() to service_role;

drop trigger if exists trg_fila_envio_pausa_por_resposta on public.messages;
create trigger trg_fila_envio_pausa_por_resposta
  after insert on public.messages
  for each row
  execute function public.fn_fila_envio_pausa_por_resposta();

revoke execute on function public.fn_fila_envio_admitir(uuid, uuid, uuid, uuid, uuid, text, smallint, timestamptz, integer, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.fn_fila_envio_admitir(uuid, uuid, uuid, uuid, uuid, text, smallint, timestamptz, integer, integer, integer, uuid) to service_role;

comment on function public.fn_fila_envio_admitir(uuid, uuid, uuid, uuid, uuid, text, smallint, timestamptz, integer, integer, integer, uuid) is
  'Admissão atômica: lock por org+canal, quota diária (fila + envios imediatos), slot pela cadeia e reflow dos pendentes. Uma transação só.';

revoke execute on function public.fn_fila_envio_reivindicar(text, timestamptz) from public, anon, authenticated;
grant execute on function public.fn_fila_envio_reivindicar(text, timestamptz) to service_role;

comment on function public.fn_fila_envio_reivindicar(text, timestamptz) is
  'Pega o proximo item pronto da fila e o trava: status=processing, tentativas+1, locked_by/locked_at, claim_token (fencing), snapshot do corpo. for update skip locked e uma transacao so — e o que segura duas instancias sem envio duplicado.';

revoke execute on function public.fn_fila_envio_sincronizar() from public,anon,authenticated;
revoke execute on function public.fn_fila_envio_reordenar(uuid,uuid,timestamptz) from public,anon,authenticated;
revoke execute on function public.fn_fila_envio_autorizar(uuid,uuid,uuid) from public,anon,authenticated;
revoke execute on function public.fn_fila_envio_alterar(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.fn_fila_envio_sincronizar() to service_role;
grant execute on function public.fn_fila_envio_reordenar(uuid,uuid,timestamptz) to service_role;
grant execute on function public.fn_fila_envio_autorizar(uuid,uuid,uuid) to service_role;
grant execute on function public.fn_fila_envio_alterar(uuid,uuid,text,text) to service_role;
