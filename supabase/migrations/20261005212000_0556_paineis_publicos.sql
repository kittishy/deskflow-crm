-- 0556: PAINÉIS PÚBLICOS
-- manifest: tabela public_panels (link sem login com números agregados, credencial é o UUID da linha, RLS sem policy + grants só ao service_role).
-- Painel público compartilhável: um link sem login que mostra números agregados
-- da organização. Mesma natureza de `ad_tracking_links` (0437): a credencial é o
-- UUID da LINHA, e a organização do painel é a que está gravada nela — nunca uma
-- que venha do pedido. Service role bypassa RLS, então o filtro de
-- `organization_id` mora na rota, não num garde do banco.
create table if not exists public.public_panels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- O opt-in da organização. Desligar esconde o painel no mesmo instante, e é por
  -- isso que a rota e a página respondem `no-store`: um painel revogado não pode
  -- sobreviver num cache de CDN com cara de atualizado.
  enabled boolean not null default true,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  -- Janela em DIAS, não em datas: quem compartilha o link não escolhe o período,
  -- e um link que abrisse `from`/`to` mediria o recorte que o destinatário
  -- quisesse. O teto é o mesmo de `lib/painel-publico/metricas.ts` (365).
  window_days integer not null default 30 check (window_days between 1 and 365),
  created_at timestamptz not null default now()
);
alter table public.public_panels enable row level security;
-- NENHUMA política: quem lê é o service role, dentro da aplicação, e a RLS com
-- policy existiria para ser atravessada. `revoke ... from public` também, porque
-- o `ALTER DEFAULT PRIVILEGES` do baseline precede toda tabela de apêndice.
revoke all on public.public_panels from public, anon, authenticated;
grant select, insert, update, delete on public.public_panels to service_role;
-- A listagem do dono é sempre por `organization_id`; o acesso público pelo UUID
-- usa a chave primária e não precisa deste índice.
create index if not exists public_panels_org_idx on public.public_panels(organization_id);
