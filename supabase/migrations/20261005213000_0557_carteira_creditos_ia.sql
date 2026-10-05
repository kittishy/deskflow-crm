-- ============================================================================
-- 0557: A CARTEIRA DE CRÉDITO DE IA
-- manifest: saldo, extrato e recargas de crédito de IA (ai_credit_balances/ledger/recharges) para cobrança por uso.
--
-- ═══ O QUE ESTA MIGRATION CRIA, E POR QUE NÃO É MAIS UMA COLUNA ═══
--
-- Três tabelas: o saldo (`ai_credit_balances`), o extrato (`ai_credit_ledger`) e
-- a entrada de dinheiro pago (`ai_credit_recharges`).
--
-- A carteira existe porque `origem_da_chave` decide QUEM PAGA A CONTA do provedor
-- (`lib/agent-engine/edge/llm/credentials.ts`):
--
--   - `credencial_da_organizacao` (BYOK): a organização cadastrou a própria
--     chave. O dinheiro é DELA e a fatura do provedor é NELA. Não passa por
--     aqui — e `lib/ai/creditos/gate.ts` recusa debitar uma chamada BYOK dentro
--     do próprio corpo, sem depender de quem chama.
--   - `chave_da_instalacao`: a chave veio do `.env` e é a mesma para todas as
--     empresas daquele servidor. Aqui o custo é de QUEM INSTALOU, e sem saldo
--     não há como saber quem.
--
-- ⚠️ ISTO NÃO É O `ai_budgets`. Os dois respondem à mesma pergunta ("esta
-- chamada pode sair?") com sinais trocados, e confundi-los é o defeito que esta
-- migration existe para impedir:
--
--   - `ai_budgets.monthly_limit_cents` é TETO DE GASTO escolhido pela
--     organização. Zera virando o mês. Tem aviso antes de parar. Bloquear é
--     reversível subindo o limite.
--   - a carteira é SALDO de dinheiro PAGO. Não avisa — aviso de saldo zerado é
--     aviso de que a IA já morreu. Só se recupera recarregando.
--
-- Ler o saldo como teto produz a falha mais cara possível aqui: a IA continua
-- falando de graça até o fim do mês, com a conta do provedor inteira no cartão
-- de quem instalou. Ler o teto como saldo bloqueia quem nunca pediu limite.
--
-- ═══ ⚠️ EFEITO VISÍVEL AO DONO DA INSTALAÇÃO ═══
--
-- NASCE COM SALDO ZERO. Uma organização que usa a chave da instalação e nunca foi
-- recarregada passa a ter `sem_saldo` na primeira chamada. Isso é a resposta
-- honesta — ninguém pagou por aquele consumo —, mas é uma mudança de
-- comportamento e o dono PRECISA saber antes: ou credita o saldo inicial, ou
-- cadastra a própria chave (BYOK, que não passa por aqui). O caminho de
-- emergência continua inteiro e por cima de tudo: `AI_BUDGET_ENFORCEMENT=off`
-- devolve a IA sem psql.
--
-- ═══ LEDGER E SALDO, E POR QUE ESTE ARQUIVO TEM OS DOIS ═══
--
-- A `loyalty_ledger` (baseline) escreveu a li do caso sem saldo: "o saldo é
-- sum(points) e nunca uma coluna: guardar o saldo faria o primeiro estorno
-- divergir em silêncio." A carteira é o caso COM saldo, e a razão é concreta: o
-- débito acontece no caminho quente de uma chamada de LLM e precisa de uma LINHA
-- para travar com `SELECT ... FOR UPDATE`. Somar o extrato ali seria reler a
-- história a cada token, e sem trava a soma não é snapshot de nada.
--
-- O que impede a divergência que a loyalty tema é o PAR: cada linha do extrato é
-- escrita na MESMA transação do saldo (`lib/ai/creditos/gate.ts` e `recarga.ts`).
-- Não é disciplina, é atomicidade — não existe instante em que os dois discordam
-- porque não existe instante em que só um deles mudou.
--
-- ⚠️ POR QUE O SALDO PODE FICAR NEGATIVO (e o CHECK NÃO IMPÕE >= 0)
--
-- Porque a corrida de duas chamadas que passaram as duas pelo gate de saldo é
-- real: as duas viram saldo 1, as duas chamam o provedor, e a segunda debita
-- depois da primeira. Esconder isso recusando o débito produziria chamada
-- registrada e não paga — consumo de graça com o extrato mentindo. A dívida
-- negativa é a verdade, e se resolve na recarga seguinte. Quem impede a dívida
-- de crescer é o gate (`sem_saldo`), e não um CHECK.
--
-- ═══ O SALDO É EM REAL; O DÓLAR SÓ EXISTE NO EXTRATO ═══
--
-- `llm_calls.cost_cents` é USD (`lib/agent-engine/edge/llm/pricing.ts`) e a
-- recarga é BRL. O saldo é BRL, porque é a moeda que a pessoa paga; e a taxa que
-- converteu é CONGELADA por lançamento, em micros inteiros
-- (`fx_rate_micros`). Recalcular o histórico com a taxa de hoje reescreve o
-- passado: o saldo de ontem deixa de bater com o extrato de ontem, e quem
-- confia no saldo perde a confiança na carteira inteira — sem nenhum erro
-- aparecer em lugar nenhum.
-- ============================================================================

-- ─── 1. O saldo, um por organização ──────────────────────────────────────────
--
-- A chave primária É a organização: é uma linha só por empresa, e a existência
-- da linha significa "esta organização tem carteira". A PK é a trava — dois
-- débitos concorrentes não têm duas linhas para disputarem, e o
-- `on conflict do nothing` do caminho quente não cria uma segunda.
create table if not exists public.ai_credit_balances (
  organization_id uuid primary key references public.organizations(id) on delete cascade,

  -- Centavos de REAL, ASSINADO. Negativo é dívida (ver o cabeçalho).
  balance_cents bigint not null default 0,

  -- Real, e só real: a coluna existe para o dado ser explícito em tela e em
  -- consulta, e para o dia em que a carteira ganhar outra moeda ser uma
  -- CHECK mudada e não uma adivinhação.
  currency text not null default 'BRL' check (currency = 'BRL'),

  updated_at timestamptz not null default now()
);

comment on table public.ai_credit_balances is
  'Saldo de crédito de IA pago, em centavos de REAL (1 linha por organização). É CACHE do extrato ai_credit_ledger: os dois mudam na mesma transação. NÃO é o teto de gasto de ai_budgets. Nace em 0.';

-- ─── 2. O extrato ───────────────────────────────────────────────────────────
--
-- O sinal é o dado: `amount_cents` é assinado e o `kind` decide o sentido. Uma
-- coluna de tipo ao lado de um valor sem sinal seria a segunda forma de dizer a
-- mesma coisa — e as duas divergem no primeiro estorno escrito à pressa.
create table if not exists public.ai_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  kind text not null check (kind in ('recharge', 'debit', 'refund', 'adjustment')),

  -- Centavos de REAL, ASSINADO. Entrada positiva, saída negativa.
  amount_cents bigint not null check (amount_cents <> 0),

  -- A moeda do `source_amount_cents`: de onde veio o número original.
  currency text not null check (currency in ('USD', 'BRL')),

  -- O valor original na moeda de `currency`. Nulo quando não houve conversão
  -- (recarga: houve real, e não um custo em dólar).
  source_amount_cents bigint,

  -- Taxa CONGELADA em micros (reais por unidade da moeda de origem). 5,00 BRL
  -- por dólar = 5_000_000. Inteiro de propósito: float em coluna de dinheiro
  -- guarda erro que só aparece na conciliação.
  fx_rate_micros bigint check (fx_rate_micros is null or fx_rate_micros > 0),

  -- A chamada que causou o débito. `set null`: apagar o registro de uma chamada
  -- não pode apagar o dinheiro que ela consumiu — o extrato sobrevive ao dado.
  llm_call_id uuid references public.llm_calls(id) on delete set null,

  -- A recarga que originou a entrada. `set null` pelo mesmo motivo.
  --
  -- ⚠️ SEM `references` AQUI, de propósito: `ai_credit_recharges` é criada
  -- DEPOIS desta tabela, e uma FK para uma tabela que ainda não existe faz a
  -- migration inteira falhar — inclusive num clone com `update.sh`, que roda sem
  -- `ON_ERROR_STOP` e engoliria o erro deixando a carteira sem extrato ligado à
  -- recarga. A FK entra no bloco `do $$` abaixo, quando o alvo já existe.
  recharge_id uuid,

  description text,

  created_at timestamptz not null default now(),

  -- ⚠️ O SINAL É DERIVADO DO TIPO, e o banco é a segunda camada. O TypeScript já
  -- monta a linha assim (`lib/ai/creditos/ledger.ts`); este CHECK existe para
  -- o `update.sh` de um clone, que roda SEM `ON_ERROR_STOP`, e para qualquer
  -- escrita que não passe por ali. Um `debit` positivo é extrato mentindo, e
  -- extrato que mente é pior que saldo errado.
  constraint ai_credit_ledger_sinal_check check (
    (kind = 'debit' and amount_cents < 0)
    or (kind = 'refund' and amount_cents < 0)
    or (kind = 'recharge' and amount_cents > 0)
    or kind = 'adjustment'
  )
);

comment on table public.ai_credit_ledger is
  'Extrato da carteira de IA. amount_cents em centavos de REAL, ASSINADO, com o sentido ditado por kind. fx_rate_micros é a taxa CONGELADA do lançamento. Somado, dá o saldo — e a coluna ai_credit_balances é o cache disso.';

-- O extrato é lido como "o que aconteceu entre duas datas" e por "por que este
-- valor". As duas perguntas são por organização e por tempo.
create index if not exists ai_credit_ledger_org_data_idx
  on public.ai_credit_ledger (organization_id, created_at desc);

-- A conciliação de uma linha específica: "este lançamento aponta para a chamada
-- certa?". Parcial, porque a maioria das linhas não tem chamada.
create index if not exists ai_credit_ledger_chamada_idx
  on public.ai_credit_ledger (llm_call_id)
  where llm_call_id is not null;

-- ─── 3. A entrada de dinheiro PAGO ───────────────────────────────────────────
--
-- Onde o webhook de pagamento vai escrever quando existir. Hoje o dono credita
-- à mão e esta tabela fica vazia — ela nasce pronta, e pronta é o ponto: quando
-- o webhook aparecer, a idempotência já está no schema, não na promessa.
create table if not exists public.ai_credit_recharges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- O id do pagamento NO PROVEDOR. Nulo na recarga manual, que não tem um.
  external_payment_id text,

  provider text not null,

  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'BRL' check (currency = 'BRL'),

  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed', 'refunded')),

  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ai_credit_recharges is
  'Entrada de dinheiro PAGO na carteira de IA. external_payment_id é o id no provedor e é a idempotência do webhook: reenvio é rotina do provedor, não defeito. Vazia enquanto o crédito for manual.';

-- ⚠️ A UNIQUE É GLOBAL, E NÃO POR ORGANIZAÇÃO — é a diferença entre "reenvio" e
-- "sequestro". Um id de pagamento do provedor é global; a mesma linha chegando
-- com outra `organization_id` é o caso que NÃO pode passar, e uma UNIQUE
-- `(organization_id, external_payment_id)` deixaria passar. Parcial de propósito:
-- a recarga manual não tem id de pagamento e não deve competir por um.
create unique index if not exists ai_credit_recharges_pagamento_unico
  on public.ai_credit_recharges (external_payment_id)
  where external_payment_id is not null;

create index if not exists ai_credit_recharges_org_data_idx
  on public.ai_credit_recharges (organization_id, created_at desc);

-- A FK do extrato só pode ser criada depois que a tabela alvo existe.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_credit_ledger_recharge_fk'
  ) then
    alter table public.ai_credit_ledger
      add constraint ai_credit_ledger_recharge_fk
      foreign key (recharge_id)
      references public.ai_credit_recharges(id) on delete set null;
  end if;
end $$;

-- ─── 4. RLS nas três ─────────────────────────────────────────────────────────
--
-- `fn_user_org_ids()` é a mesma função SECURITY DEFINER que o RBAC usa. A policy é
-- de LEITURA para o membro da organização: quem escreve é o service role (o
-- gate e a recarga), e uma policy de escrita para gerente deixaria o PostgREST
-- creditar saldo sem filtro e sem auditoria.
--
-- O `revoke` explícito é o que protege no Supabase real: o default ACL de
-- tabelas em `public` concede tudo a anon/authenticated (ver CLAUDE.md, 0258).
do $$
declare t text;
begin
  foreach t in array array['ai_credit_balances', 'ai_credit_ledger', 'ai_credit_recharges'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation_%I_all on public.%I', t, t);
    execute format($f$
      create policy tenant_isolation_%I_all on public.%I
        for all
        using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())
        with check (
          public.fn_is_platform_admin()
          or (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'agent'))
        )
    $f$, t, t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- `updated_at` nas duas que mudam. Reuso de `fn_set_updated_at()` em vez de um
-- trigger novo: a função existe, é testada, e uma segunda cópia divergiria.
drop trigger if exists trg_ai_credit_balances_updated_at on public.ai_credit_balances;
create trigger trg_ai_credit_balances_updated_at
  before update on public.ai_credit_balances
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_ai_credit_recharges_updated_at on public.ai_credit_recharges;
create trigger trg_ai_credit_recharges_updated_at
  before update on public.ai_credit_recharges
  for each row execute function public.fn_set_updated_at();

-- ─── travas do suporte, depois de toda tabela nova (migration 0274) ─────────
-- Tabela nova (lida por `authenticated`, escrita só pelo service role): sem
-- chamar de novo aqui, a cadeia de migrations/ (aplicada em produção via
-- CLI/MCP, uma a uma) nunca ganharia as três travas support_write_* nesta
-- tabela. No baseline.sql o apêndice desta migration entra ANTES do bloco da
-- VARREDURA anon (0116), e o ÚLTIMO `fn_aplicar_travas_de_suporte()` do arquivo
-- já cobre esta tabela — por isso o apêndice NÃO repete esta chamada.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';