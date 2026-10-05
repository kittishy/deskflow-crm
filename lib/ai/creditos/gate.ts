/**
 * O GATE DA CARTEIRA — quem responde "esta chamada pode sair?" e quem paga por ela.
 *
 * ═══ DUAS PORTAS, DUAS PROVAS ═══
 *
 *   1. A PORTA DA DECISÃO, `checarAntesDaChamada`. Ela NÃO decide sozinha:
 *      delega a `decidirOrcamento` (`lib/agent-engine/edge/llm/orcamento.ts`), o
 *      mesmo lugar onde o teto de gasto decide. Um segundo lugar que decide é
 *      onde nasce o "por que a IA parou" sem resposta — e o `orcamento.ts` é
 *      puro justamente para poder ser o único.
 *
 *   2. A PORTA DO DÉBITO, `debitarChamadaDeIa`. Ela RECUSA debitar uma chamada
 *      BYOK dentro do próprio corpo, sem depender de quem chama lembrar. Se a
 *      organização cadastrou a própria chave, o dinheiro é DELA e a conta é
 * *dela*: debitar a carteira da plataforma aqui seria cobrar duas vezes pelo
 *      mesmo token. Regra que depende de convenção não é regra.
 *
 * ═══ ⚠️ A ATOMICIDADE É A GARantia, NÃO UM DETALHE ═══
 *
 * O débito e o `insert` de `llm_calls` têm que ser a MESMA transação:
 * chamada registrada e não paga é consumo de graça (a organização paga a conta do
 * provedor e não recebe nada disso), e paga sem registro é dinheiro que sai sem
 * rastro (ninguém consegue conferir nada na conciliação).
 *
 * Por isso a sequência usa `SELECT ... FOR UPDATE` no saldo e NÃO um SELECT
 * seguido de UPDATE: dois workers que leiam 1.000 e subtraiam cada um 10 deixam o
 * saldo em 990 tendo consumido 20. Com o lock, o segundo débito espera e lê o
 * valor já atualizado.
 *
 * E por isso `debitarChamadaDeIa` exige um CLIENTE, não um pool: ele roda dentro
 * da transação que quem chama abriu — a mesma que gravou `llm_calls`. Um pool
 * aqui devolveria uma conexão diferente, e a transação seria fiction.
 *
 * ═══ A CARTEIRA NÃO SUBSTITUI O TETO DE GASTO ═══
 *
 * `ai_budgets.monthly_limit_cents` é teto de gasto escolhido pela organização,
 * que zera virando o mês e tem aviso antes de parar. A carteira é dinheiro pago,
 * que não avisa (aviso de saldo zerado é aviso de que a IA já morreu) e só se
 * recupera recarregando. Os dois convivem: saldo cheio não abre o teto, e teto
 * estourado não vira `sem_saldo`.
 */
import {
  converterCredito,
  microssDaTaxa,
  MOEDA_DA_CARTEIRA,
} from '@/lib/ai/creditos/carteira';
import {
  linhaDeDebito,
  parametrosDoLancamento,
  SQL_INSERT_LANCAMENTO,
} from '@/lib/ai/creditos/ledger';
import {
  decidirOrcamento,
  type EntradaDeOrcamento,
  type OrigemDaChave,
  type Veredito,
} from '@/lib/agent-engine/edge/llm/orcamento';

/**
 * O mínimo de um `pg` que estas funções usam. Deliberadamente estreito: um
 * `pg.Pool` e um `pg.PoolClient` satisfazem, e um duplo de teste também — o que
 * é o que permite provar a SEQUÊNCIA do SQL sem subir um Postgres.
 *
 * ⚠️ `rows: unknown[]` e não `rows: R[]`: o `query` do `node-postgres` é uma
 * sobrecarga genérica com restrição (`R extends QueryResultRow`), e reproduzir
 * essa assinatura aqui para "ganhar" tipagem na chamada faz o `pg.Pool` — o
 * cliente REAL — deixar de satisfazer a interface. O `unknown` obriga o cast
 * explícito em cada leitura, que é o que a doutrina quer de um número que vem
 * do banco.
 */
export interface ClienteDeCredito {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** Pool OU cliente: a LEITURA pode vir de qualquer um (não está na transação). */
export type AlvoDeCredito =
  | ClienteDeCredito
  | { connect(): Promise<ClienteDeCredito> };

/** Resolve um pool para cliente. Um cliente já é o que queremos. */
async function comoCliente(db: AlvoDeCredito): Promise<ClienteDeCredito> {
  if (typeof (db as { connect?: unknown }).connect === 'function') {
    return (db as { connect(): Promise<ClienteDeCredito> }).connect();
  }
  return db as ClienteDeCredito;
}

/**
 * Garante que a organização TEM linha de saldo, sem falhar se já tem.
 *
 * Idempotente e separata do `FOR UPDATE` porque as duas coisas num statement só
 * NÃO FUNCIONAM: CTEs que modificam dados no Postgres não enxergam o efeito das
 * outras, então o `UPDATE` do mesmo statement que faz o `INSERT ... ON CONFLICT`
 * não encontra a linha que acabou de nascer e o débito é pulado em silêncio. A
 * ordem em três statements é o que funciona — e ela só é atômica porque quem
 * chama já está numa transação.
 */
export const SQL_GARANTIR_LINHA_DE_SALDO = `
  insert into public.ai_credit_balances (organization_id, balance_cents, currency)
  values ($1, 0, $2)
  on conflict (organization_id) do nothing`;

/**
 * A LEITURA TRAVADA do saldo. O `for update` é o que serializa os débitos
 * concorrentes, e é o que transforma a subtração seguinte em aritmética correta
 * em vez de última-escrita-ganha.
 *
 * ⚠️ Traz o `id`, e isso não é excesso de coluna: o `UPDATE` de baixo amarra a
 * subtração pelo ID, e uma subtração que re-lê a linha sem saber QUAL linha
 * trancou é exatamente a janela que o lock queria fechar.
 */
export const SQL_TRAVAR_SALDO = `
  select id, balance_cents
    from public.ai_credit_balances
   where organization_id = $1
     for update`;

/**
 * A subtração, por ID — e não por `balance_cents = balance_cents - $2`, que
 * pareceria mais segura. Já temos a linha travada acima, então o valor é o
 * nosso; recalcular a partir da coluna reabriria a janela em que outra
 * transação entrou. O `id` é o que amarra a subtração exatamente à linha lida.
 */
export const SQL_DEBITAR_SALDO = `
  update public.ai_credit_balances
     set balance_cents = balance_cents - $2, updated_at = now()
   where id = $1
  returning balance_cents`;

export interface LeituraDeSaldo {
  /**
   * Centavos de REAL. `null` = NÃO DEU PARA LER, e isso é diferente de `0`:
   * `0` bloqueia a IA (a organização não tem crédito), `null` deixa passar e faz
   * o gate gritar no log (não sabemos). Uma organização que nunca recarregou tem
   * `0` — é honesto. Um clone sem a migrationApplied tem `null` — calar a IA
   * por causa de um clone desatualizado seria um defeito de instalação, não de
   * produto.
   */
  saldoReaisCents: number | null;
  /** Só não-nulo quando o saldo é `null`. A causa, já pronta para o log. */
  indisponivelPorque: string | null;
}

/** SQLSTATE + mensagem em uma linha, sem segredo: é o que separa `42703` de "o banco caiu". */
function causaDoBanco(err: unknown): string {
  const codigo = (err as { code?: unknown } | null)?.code;
  const texto = err instanceof Error ? err.message : String(err);
  return `${typeof codigo === 'string' ? codigo : 'sem_sqlstate'}: ${texto}`.slice(0, 300);
}

export const SQL_LER_SALDO = `
  select balance_cents
    from public.ai_credit_balances
   where organization_id = $1`;

/**
 * O saldo para o gate. NUNCA lança: uma falha de leitura não pode derrubar a
 * chamada de LLM (ver `credentials.ts:301-314` — o mesmo lemma, o resolvedor
 * nunca lança por schema desatualizado). Falha vira `null` + causa nomeada.
 */
export async function lerSaldoDaCarteira(
  db: AlvoDeCredito,
  organizationId: string,
): Promise<LeituraDeSaldo> {
  try {
    // O `await` é no `comoCliente`, e não no `.query`: como ele é `async`,
    // `await comoCliente(db).query(...)` esperaria o RESULTADO da query de um
    // Promise — que não tem `.query` — e a falha apareceria como "query is not a
    // function", que é a mensagem mais longe possível da causa.
    const client = await comoCliente(db);
    const { rows } = await client.query(SQL_LER_SALDO, [organizationId]);
    const bruto = (rows[0] as { balance_cents?: unknown } | undefined)?.balance_cents;
    const saldo = typeof bruto === 'number' ? bruto : Number(bruto ?? 0);
    if (!Number.isFinite(saldo)) {
      // Um saldo não numérico é "não sei", nunca 0: `NaN <= 0` é false, então
      // converter NaN em 0 calaria a IA sem ninguém saber por quê.
      return {
        saldoReaisCents: null,
        indisponivelPorque: 'saldo_ilegivel: ai_credit_balances.balance_cents não é número',
      };
    }
    // Sem linha = nunca recarregou = saldo zero. Não é "não sei": é zero.
    return { saldoReaisCents: saldo, indisponivelPorque: null };
  } catch (err) {
    return { saldoReaisCents: null, indisponivelPorque: causaDoBanco(err) };
  }
}

/**
 * O estado do orçamento da ORGANIZAÇÃO, do jeito que `decidirOrcamento` quer.
 * Separado do da carteira porque são coisas diferentes, e o teste troca um de
 * cada vez.
 */
export interface EntradaDaDecisao {
  /** `origemDaChave` do resolvedor. Ausente = a carteira não entra na decisão. */
  origemDaChave?: OrigemDaChave;
  /** `RunModelCallInput.purpose` já resolvido. */
  purpose: string;
  /** `null` quando não deu para ler a carteira. */
  saldoReaisCents: number | null;
  /** O resto do estado do `SQL_ORCAMENTO`. */
  orcamento: {
    modo: EntradaDeOrcamento['modo'];
    tetoCents: number;
    gastoCents: number;
    limiarPct: number;
    efetivoEm?: Date | null;
    agora?: Date;
    chave?: EntradaDeOrcamento['chave'];
    avisadoNesteMes?: boolean;
  };
}

/**
 * A decisão, sem I/O. Delega a `decidirOrcamento` — o mesmo lugar do teto — e
 * injeta os dois campos da carteira. Quem chama já leu o saldo e já tem o resto
 * do snapshot do teto.
 */
export function checarAntesDaChamada(entrada: EntradaDaDecisao): Veredito {
  return decidirOrcamento({
    modo: entrada.orcamento.modo,
    tetoCents: entrada.orcamento.tetoCents,
    gastoCents: entrada.orcamento.gastoCents,
    limiarPct: entrada.orcamento.limiarPct,
    efetivoEm: entrada.orcamento.efetivoEm ?? null,
    agora: entrada.orcamento.agora ?? new Date(),
    purpose: entrada.purpose,
    chave: entrada.orcamento.chave ?? 'on',
    avisadoNesteMes: entrada.orcamento.avisadoNesteMes ?? false,
    origemDaChave: entrada.origemDaChave,
    saldoReaisCents: entrada.saldoReaisCents,
  });
}

export type MotivoDoDebito =
  /** BYOK: o dinheiro é da organização e a conta é dela. */
  | 'chave_da_organizacao'
  /** Modelo grátis: nenhum dinheiro movimento, nenhum lançamento. */
  | 'custo_zero';

export interface DebitoAplicado {
  debitado: boolean;
  motivo?: MotivoDoDebito;
  debitoReaisCents: number;
  /** `null` quando nada foi debitado. */
  saldoRestanteReaisCents: number | null;
  lancamentoId: string | null;
}

export interface EntradaDoDebito {
  organizationId: string;
  /** Decide o gate: BYOK não entra, e a recusa acontece ANTES de qualquer SQL. */
  origemDaChave: OrigemDaChave;
  /** `llm_calls.cost_cents`, em USD. */
  custoOrigemCents: number;
  taxaBrlPorUnidade: number;
  llmCallId: string;
  descricao?: string | null;
}

/**
 * Debita a carteira e grava o extrato — na MESMA transação de quem chamou.
 *
 * ⚠️ Ordem, e cada passo tem um porque:
 *   1. BYOK? Sai agora, sem tocar em nada. Zerar custo é melhor que cobrar.
 *   2. custo zero? Sai: sem dinheiro em movimento, sem lançamento.
 *   3. `INSERT ... ON CONFLICT DO NOTHING` na linha de saldo.
 *   4. `SELECT ... FOR UPDATE` — a trava. Sem ela, dois débitos concorrentes
 *      leem o mesmo saldo e um dos dois se perde.
 *   5. `UPDATE` do saldo pelo ID travado.
 *   6. `INSERT` do lançamento, com a taxa JÁ CONGELADA.
 *
 * ⚠️ O débito NÃO é condicionado a `balance_cents >= custo`. Um saldo que não dá
 * conta vira dívida negativa em vez de chamadas não cobradas: a dívida se
 * recupera na recarga seguinte e é verdade; a chamada não paga não se recupera
 * nunca, e o ledger para de dizer a verdade. Quem impede a dívida de crescer é o
 * gate (`sem_saldo`), não este passo.
 */
export async function debitarChamadaDeIa(
  client: ClienteDeCredito,
  entrada: EntradaDoDebito,
): Promise<DebitoAplicado> {
  if (entrada.origemDaChave !== 'chave_da_instalacao') {
    return {
      debitado: false,
      motivo: 'chave_da_organizacao',
      debitoReaisCents: 0,
      saldoRestanteReaisCents: null,
      lancamentoId: null,
    };
  }

  const conversao = converterCredito({
    custoOrigemCents: entrada.custoOrigemCents,
    taxaBrlPorUnidade: entrada.taxaBrlPorUnidade,
  });
  if (conversao.debitoReaisCents === 0) {
    return {
      debitado: false,
      motivo: 'custo_zero',
      debitoReaisCents: 0,
      saldoRestanteReaisCents: null,
      lancamentoId: null,
    };
  }
  const linha = linhaDeDebito({
    custoOrigemCents: entrada.custoOrigemCents,
    taxaBrlPorUnidade: entrada.taxaBrlPorUnidade,
    llmCallId: entrada.llmCallId,
    descricao: entrada.descricao ?? null,
  });
  // `linhaDeDebito` devolve `null` só quando o custo é 0, e isso já saiu acima.
  // A guarda existe para o tipo Narrower e para o dia em que alguém acrescentar
  // um motivo de linha ausente: um `null` aqui viraria `TypeError` no meio da
  // transação de quem chamou.
  if (linha === null) {
    return {
      debitado: false,
      motivo: 'custo_zero',
      debitoReaisCents: 0,
      saldoRestanteReaisCents: null,
      lancamentoId: null,
    };
  }

  await client.query(SQL_GARANTIR_LINHA_DE_SALDO, [
    entrada.organizationId,
    MOEDA_DA_CARTEIRA,
  ]);

  const travado = await client.query(SQL_TRAVAR_SALDO, [entrada.organizationId]);
  const linhaSaldo = travado.rows[0] as { id?: unknown; balance_cents?: unknown } | undefined;
  // A linha acabou de ser garantida acima, então ela existe. Se não existir
  // mesmo assim, o banco está em estado impossível — e é isso que se levanta
  // aqui, e não um `0` que faria a chamada passar como se fosse uma organização
  // sem crédito.
  if (linhaSaldo?.id === undefined) {
    throw new Error(`linha_de_saldo_ausente: ${entrada.organizationId}`);
  }

  await client.query(SQL_DEBITAR_SALDO, [linhaSaldo.id, conversao.debitoReaisCents]);

  const lancamento = await client.query(
    SQL_INSERT_LANCAMENTO,
    parametrosDoLancamento(entrada.organizationId, linha),
  );
  const lancamentoId = (lancamento.rows[0] as { id?: unknown } | undefined)?.id ?? null;

  return {
    debitado: true,
    debitoReaisCents: conversao.debitoReaisCents,
    saldoRestanteReaisCents: Number(linhaSaldo.balance_cents ?? 0) - conversao.debitoReaisCents,
    lancamentoId: typeof lancamentoId === 'string' ? lancamentoId : null,
  };
}

/**
 * A taxa congelada que o chamador vai gravar. Exportada de novo porque quem
 * monta a chamada tem o custo e a taxa antes de ter o `llmCallId` — e gravar a
 * taxa num lugar e o custo noutro é como um extrato começa a discordar de si.
 */
export { microssDaTaxa };