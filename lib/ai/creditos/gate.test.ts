/**
 * O GATE DA CARTEIRA — quem decide se a chamada sai, e quem paga por ela.
 *
 * ═══ O QUE ESTE ARQUIVO PROVA, E POR QUE É O ARQUIVO IMPORTANTE ═══
 *
 * A carteira tem exatamente duas Portas, e as duas precisam ser fechadas com
 * prova, não com convenção:
 *
 *   1. A PORTA DA DECISÃO, `checarAntesDaChamada`. Ela NÃO decide sozinha:
 *      delega a `decidirOrcamento`, o mesmo lugar onde o teto de gasto decide.
 *      Um segundo lugar que decide é onde nasce "por que a IA parou" sem
 *      resposta.
 *
 *   2. A PORTA DO DÉBITO, `debitarChamadaDeIa`. Ela RECUSA debitar uma chamada
 *      BYOK dentro do próprio corpo — não por convenção de quem chama. Se a
 *      organização cadastrou a própria chave, o dinheiro é DELA e a conta é
 *      dela; debitar a carteira da plataforma aqui seria cobrar duas vezes pelo
 *      mesmo token.
 *
 * ═══ ⚠️ O QUE ESTE ARQUIVO NÃO MUDA ═══
 *
 * O teto de gasto (`ai_budgets`) continua valendo para as DUAS origens de chave,
 * inclusive BYOK. A carteira não o substitui em lugar nenhum: ela entra no
 * caminho da chave da instalação e some no da chave da organização. Há teste
 * nomeado para isso, porque o erro silencioso aqui é plausível e caro —
 * desabilitar o teto de quem pagou por ele.
 */
import { describe, expect, it } from 'vitest';

import {
  checarAntesDaChamada,
  debitarChamadaDeIa,
  lerSaldoDaCarteira,
} from '@/lib/ai/creditos/gate';

/** Teto desligado: isola a carteira de tudo que não é ela. */
const SEM_TETO = { modo: 'off', tetoCents: 0, gastoCents: 0, limiarPct: 80 } as const;

/** Teto estourado com aviso já dado: o estado que BLOQUEIA por gasto. */
const TETO_ESTOURADO = {
  modo: 'bloquear',
  tetoCents: 5_000,
  gastoCents: 5_000,
  limiarPct: 80,
  avisadoNesteMes: true,
  efetivoEm: new Date('2026-08-13T12:00:00.000Z'),
  agora: new Date('2026-08-14T12:00:00.000Z'),
  chave: 'on',
} as const;

/**
 * O SQL SEM COMENTÁRIO. Existe porque um `for update` comentado NÃO trava nada —
 * e um teste que casa o texto cru passa verde com o travamento removido. Foi
 * exatamente o que aconteceu quando esta asserção foi escrita pela primeira vez:
 * o sabotador "-- for update" continuava casando o regex.
 */
function sqlEfetivo(q: { sql: string }): string {
  return q.sql.replace(/--[^\n]*/g, ' ');
}

/**
 * Cliente de mentira que REGISTRA o SQL. O que se prova aqui não é o retorno —
 * é a SEQUÊNCIA e o TEXTO: o que roda, em que ordem, e se toca a carteira
 * quando não deve.
 */
function clienteFalso(saldoInicial: number | 'sem_linha' = 1_000) {
  const executados: { sql: string; params: unknown[] }[] = [];
  const temLinha = saldoInicial !== 'sem_linha';
  let saldo = temLinha ? (saldoInicial as number) : 0;
  return {
    executados,
    saldoAtual: () => saldo,
    async query(text: string, params: unknown[] = []) {
      executados.push({ sql: text, params });
      if (/for update/i.test(sqlEfetivo({ sql: text }))) {
        // `id` E `balance_cents`: o UPDATE de baixo amarra a subtração pelo id,
        // e um duplo que não devolve o id mediria um banco impossível.
        return { rows: [{ id: 'saldo-1', balance_cents: saldo }], rowCount: 1 };
      }
      if (/update\s+(public\.)?ai_credit_balances/i.test(text)) {
        saldo -= Number(params[1] ?? 0);
        return { rows: [], rowCount: 1 };
      }
      if (/insert\s+(into\s+)?(public\.)?ai_credit_balances/i.test(text)) {
        return { rows: [], rowCount: 1 };
      }
      if (/select\s+balance_cents/i.test(text)) {
        return temLinha
          ? { rows: [{ balance_cents: saldo }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

/** O mesmo cliente, mas sobre um pool — a LEITURA aceita os dois. */
function poolDe(saldo: number | 'sem_linha' = 1_000) {
  const interno = clienteFalso(saldo);
  return {
    executados: interno.executados,
    saldoAtual: interno.saldoAtual,
    async connect() {
      return interno;
    },
  };
}

describe('a porta da decisão — a carteira nao entra no caminho BYOK', () => {
  it('BYOK com saldo zerado SEGUE: o dinheiro e da organizacao', () => {
    const v = checarAntesDaChamada({
      origemDaChave: 'credencial_da_organizacao',
      purpose: 'agent_turn',
      saldoReaisCents: 0,
      orcamento: SEM_TETO,
    });
    expect(v.acao).toBe('seguir');
  });

  it('BYOK ignora a carteira mesmo com saldo NEGATIVO', () => {
    const v = checarAntesDaChamada({
      origemDaChave: 'credencial_da_organizacao',
      purpose: 'agent_turn',
      saldoReaisCents: -999,
      orcamento: SEM_TETO,
    });
    expect(v.acao).toBe('seguir');
  });

  it('BYOK nao desliga o TETO DE GASTO — a carteira nao o substitui', () => {
    // A regressao que importa: se o caminho BYOK SAISSE antes do teto, toda
    // organizacao com chave propria e limite configurado ficaria sem teto. O
    // gasto e dela, e o limite escolhido por ela tambem.
    const v = checarAntesDaChamada({
      origemDaChave: 'credencial_da_organizacao',
      purpose: 'agent_turn',
      saldoReaisCents: 0,
      orcamento: TETO_ESTOURADO,
    });
    expect(v).toEqual({ acao: 'bloquear', porque: 'teto_atingido' });
  });

  it('origem ausente NAO desliga o teto: e o chamador antigo, sem carteira', () => {
    // `origemDaChave` ausente significa "este chamador nao fala de carteira".
    // Tratar o ausente como plataforma MORRERIA aqui.
    const v = checarAntesDaChamada({
      origemDaChave: undefined,
      purpose: 'agent_turn',
      saldoReaisCents: 0,
      orcamento: TETO_ESTOURADO,
    });
    expect(v).toEqual({ acao: 'bloquear', porque: 'teto_atingido' });
  });

  it('origem desconhecida (valor novo) e tratada como sem carteira', () => {
    const v = checarAntesDaChamada({
      origemDaChave: 'origem_do_futuro' as never,
      purpose: 'agent_turn',
      saldoReaisCents: 0,
      orcamento: SEM_TETO,
    });
    expect(v.acao).toBe('seguir');
  });
});

describe('a porta da decisao — chave da instalacao consome a carteira', () => {
  it('saldo positivo SEGUE', () => {
    const v = checarAntesDaChamada({
      origemDaChave: 'chave_da_instalacao',
      purpose: 'agent_turn',
      saldoReaisCents: 1,
      orcamento: SEM_TETO,
    });
    expect(v.acao).toBe('seguir');
  });

  it('saldo ZERADO bloqueia com sem_saldo', () => {
    const v = checarAntesDaChamada({
      origemDaChave: 'chave_da_instalacao',
      purpose: 'agent_turn',
      saldoReaisCents: 0,
      orcamento: SEM_TETO,
    });
    expect(v).toEqual({ acao: 'bloquear', porque: 'sem_saldo' });
  });

  it('saldo NEGATIVO tambem bloqueia — divida e <= 0', () => {
    const v = checarAntesDaChamada({
      origemDaChave: 'chave_da_instalacao',
      purpose: 'agent_turn',
      saldoReaisCents: -1,
      orcamento: SEM_TETO,
    });
    expect(v).toEqual({ acao: 'bloquear', porque: 'sem_saldo' });
  });

  it('um centavo SEGUE — e e por isso que o piso de 1 centavo importa', () => {
    const v = checarAntesDaChamada({
      origemDaChave: 'chave_da_instalacao',
      purpose: 'agent_turn',
      saldoReaisCents: 1,
      orcamento: SEM_TETO,
    });
    expect(v.acao).toBe('seguir');
  });

  it('saldo INDISPONIVEL segue, com a causa nomeada', () => {
    // Clone sem a migration, banco fora: nao se sabe o saldo. Quem nao sabe
    // deixa passar e grita no log — calar a IA por causa de clone desatualizado
    // e defeito de instalacao, nao de produto.
    const v = checarAntesDaChamada({
      origemDaChave: 'chave_da_instalacao',
      purpose: 'agent_turn',
      saldoReaisCents: null,
      orcamento: SEM_TETO,
    });
    expect(v).toEqual({ acao: 'seguir', porque: 'saldo_indisponivel' });
  });

  it('a chave de emergencia do operador vence o saldo zerado', () => {
    // `AI_BUDGET_ENFORCEMENT=off` e a valvula documentada: "IA volta — sem psql,
    // sem saber SQL". Se a carteira passar por cima dela, quem opera a VPS nao
    // tem volta nenhuma quando o saldo zera.
    const v = checarAntesDaChamada({
      origemDaChave: 'chave_da_instalacao',
      purpose: 'agent_turn',
      saldoReaisCents: 0,
      orcamento: { ...SEM_TETO, chave: 'off' },
    });
    expect(v).toEqual({ acao: 'seguir', porque: 'chave_de_emergencia' });
  });

  it('a valvula de emergencia tambem vence o teto estourado', () => {
    const v = checarAntesDaChamada({
      origemDaChave: 'chave_da_instalacao',
      purpose: 'agent_turn',
      saldoReaisCents: 0,
      orcamento: { ...TETO_ESTOURADO, chave: 'off' },
    });
    expect(v).toEqual({ acao: 'seguir', porque: 'chave_de_emergencia' });
  });

  it('diagnostico e guardrail nao sao barrados por carteira vazia', () => {
    for (const purpose of ['connection_test', 'jailbreak_detect', 'promise_semantic']) {
      const v = checarAntesDaChamada({
        origemDaChave: 'chave_da_instalacao',
        purpose,
        saldoReaisCents: 0,
        orcamento: SEM_TETO,
      });
      expect(v.acao).toBe('seguir');
    }
  });

  it('o teto de gasto continua valendo DEPOIS do saldo — os dois nao se substituem', () => {
    // Saldo cheio e teto estourado: quem para e o teto, com a razao DELE. A
    // carteira nunca pode virar o alibi do teto.
    const v = checarAntesDaChamada({
      origemDaChave: 'chave_da_instalacao',
      purpose: 'agent_turn',
      saldoReaisCents: 999_999,
      orcamento: TETO_ESTOURADO,
    });
    expect(v).toEqual({ acao: 'bloquear', porque: 'teto_atingido' });
  });

  it('saldo zerado vence o teto que ainda nao estourou, e com a razao DELE', () => {
    const v = checarAntesDaChamada({
      origemDaChave: 'chave_da_instalacao',
      purpose: 'agent_turn',
      saldoReaisCents: 0,
      orcamento: { ...TETO_ESTOURADO, gastoCents: 0 },
    });
    expect(v).toEqual({ acao: 'bloquear', porque: 'sem_saldo' });
  });
});

describe('a leitura do saldo', () => {
  it('le o saldo de uma linha de carteira existente', async () => {
    const lido = await lerSaldoDaCarteira(poolDe(4_321), 'org-1');
    expect(lido).toEqual({ saldoReaisCents: 4_321, indisponivelPorque: null });
  });

  it('org sem linha de carteira le como saldo ZERO, nao como indisponivel', async () => {
    // Organizacao que nunca recarregou e saldo 0 — e saldo 0 bloqueia, que e a
    // resposta honesta. "Sem linha" e "nao deu para ler" sao coisas diferentes,
    // e confundir as duas transformaria toda org nova em org com IA calada por
    // bug de leitura.
    const lido = await lerSaldoDaCarteira(poolDe('sem_linha'), 'org-1');
    expect(lido).toEqual({ saldoReaisCents: 0, indisponivelPorque: null });
  });

  it('falha de banco vira indisponivel COM CAUSA, e o saldo vira null', async () => {
    const quebrado = {
      async connect(): Promise<never> {
        throw new Error('connection refused');
      },
    };
    const lido = await lerSaldoDaCarteira(quebrado, 'org-1');
    expect(lido.saldoReaisCents).toBeNull();
    expect(lido.indisponivelPorque).toContain('connection refused');
  });

  it('um saldo nao numerico do banco vira null, nunca 0', async () => {
    // `Number('abc')` e NaN; `NaN <= 0` e false, entao um NaN que virasse 0
    // pararia a IA sem ninguem saber por que.
    const lido = await lerSaldoDaCarteira(
      {
        async query() {
          return { rows: [{ balance_cents: 'abc' }], rowCount: 1 };
        },
      },
      'org-1',
    );
    expect(lido.saldoReaisCents).toBeNull();
    expect(lido.indisponivelPorque).toContain('saldo');
  });
});

describe('a porta do debito', () => {
  const INSTALACAO = { origemDaChave: 'chave_da_instalacao' } as const;

  it('chamada BYOK nao toca em NENHUMA tabela da carteira', async () => {
    const cliente = clienteFalso(1_000);
    const r = await debitarChamadaDeIa(cliente, {
      organizationId: 'org-1',
      origemDaChave: 'credencial_da_organizacao',
      custoOrigemCents: 2,
      taxaBrlPorUnidade: 5,
      llmCallId: 'call-1',
    });
    expect(r.debitado).toBe(false);
    expect(r.motivo).toBe('chave_da_organizacao');
    // A prova e a ausencia de SQL, nao a ausencia de erro.
    expect(cliente.executados).toHaveLength(0);
  });

  it('chave da instalacao debita o valor convertido', async () => {
    const cliente = clienteFalso(1_000);
    const r = await debitarChamadaDeIa(cliente, {
      organizationId: 'org-1',
      ...INSTALACAO,
      custoOrigemCents: 2,
      taxaBrlPorUnidade: 5,
      llmCallId: 'call-1',
    });
    expect(r.debitado).toBe(true);
    expect(r.debitoReaisCents).toBe(10);
    expect(r.saldoRestanteReaisCents).toBe(990);
    expect(cliente.saldoAtual()).toBe(990);
  });

  it('trava o saldo com FOR UPDATE ANTES de mexer nele', async () => {
    // Sem o FOR UPDATE, dois workers leem 1.000 e ambos subtraem: o saldo final
    // perde uma das duas chamadas. A ordem das duas instrucoes E a garantia.
    const cliente = clienteFalso(1_000);
    await debitarChamadaDeIa(cliente, {
      organizationId: 'org-1',
      ...INSTALACAO,
      custoOrigemCents: 2,
      taxaBrlPorUnidade: 5,
      llmCallId: 'call-1',
    });
    const iLock = cliente.executados.findIndex((q) => /for update/i.test(sqlEfetivo(q)));
    const iUpdate = cliente.executados.findIndex((q) =>
      /update\s+(public\.)?ai_credit_balances/i.test(q.sql),
    );
    expect(iLock).toBeGreaterThanOrEqual(0);
    expect(iUpdate).toBeGreaterThan(iLock);
  });

  it('o UPDATE amarra a subtracao pelo id da linha travada', async () => {
    const cliente = clienteFalso(1_000);
    await debitarChamadaDeIa(cliente, {
      organizationId: 'org-1',
      ...INSTALACAO,
      custoOrigemCents: 2,
      taxaBrlPorUnidade: 5,
      llmCallId: 'call-1',
    });
    const update = cliente.executados.find((q) =>
      /update\s+(public\.)?ai_credit_balances/i.test(q.sql),
    );
    // Um UPDATE que re-le a linha sem saber QUAL linha trancou reabre a janela
    // que o lock queria fechar.
    expect(update!.params[0]).toBe('saldo-1');
  });

  it('o lancamento no extrato sai DEPOIS do saldo, na mesma sequencia', async () => {
    const cliente = clienteFalso(1_000);
    await debitarChamadaDeIa(cliente, {
      organizationId: 'org-1',
      ...INSTALACAO,
      custoOrigemCents: 2,
      taxaBrlPorUnidade: 5,
      llmCallId: 'call-1',
    });
    const iLedger = cliente.executados.findIndex((q) =>
      /insert\s+(into\s+)?(public\.)?ai_credit_ledger/i.test(q.sql),
    );
    const iUpdate = cliente.executados.findIndex((q) =>
      /update\s+(public\.)?ai_credit_balances/i.test(q.sql),
    );
    expect(iLedger).toBeGreaterThan(iUpdate);
  });

  it('o lancamento carrega a chamada, o custo em dolar e a taxa congelada', async () => {
    const cliente = clienteFalso(1_000);
    await debitarChamadaDeIa(cliente, {
      organizationId: 'org-1',
      ...INSTALACAO,
      custoOrigemCents: 2,
      taxaBrlPorUnidade: 5,
      llmCallId: 'call-9',
    });
    const lancamento = cliente.executados.find((q) =>
      /insert\s+(into\s+)?(public\.)?ai_credit_ledger/i.test(q.sql),
    );
    expect(lancamento).toBeDefined();
    expect(lancamento!.params).toContain('debit');
    expect(lancamento!.params).toContain(-10); // o que saiu da carteira
    expect(lancamento!.params).toContain(2); // o custo em USD
    expect(lancamento!.params).toContain(5_000_000); // a taxa congelada
    expect(lancamento!.params).toContain('call-9'); // a chamada que causou
  });

  it('custo zero nao debita nem escreve extrato', async () => {
    const cliente = clienteFalso(1_000);
    const r = await debitarChamadaDeIa(cliente, {
      organizationId: 'org-1',
      ...INSTALACAO,
      custoOrigemCents: 0,
      taxaBrlPorUnidade: 5,
      llmCallId: 'call-1',
    });
    expect(r.debitado).toBe(false);
    expect(r.motivo).toBe('custo_zero');
    expect(cliente.saldoAtual()).toBe(1_000);
  });

  it('org sem linha de carteira recebe a linha ANTES de travar', async () => {
    // Sem o INSERT idempotente, o `FOR UPDATE` volta zero linhas e a chamada
    // passa sem debitar nunca. A ordem e: garante, trava, debita.
    const cliente = clienteFalso('sem_linha');
    await debitarChamadaDeIa(cliente, {
      organizationId: 'org-1',
      ...INSTALACAO,
      custoOrigemCents: 2,
      taxaBrlPorUnidade: 5,
      llmCallId: 'call-1',
    });
    expect(cliente.executados[0]!.sql).toMatch(/on conflict/i);
    expect(cliente.executados[0]!.sql).toMatch(/ai_credit_balances/i);
  });

  it('um saldo que nao da conta NAO impede o debito — ele vira divida', async () => {
    // Pular o debito quando o saldo nao cobre deixaria a chamada registrada e nao
    // paga. Um ledger que mente sobre dinheiro e pior que um saldo negativo: o
    // negativo se recupera na recarga, a mentira nao.
    const cliente = clienteFalso(1);
    const r = await debitarChamadaDeIa(cliente, {
      organizationId: 'org-1',
      ...INSTALACAO,
      custoOrigemCents: 100,
      taxaBrlPorUnidade: 5,
      llmCallId: 'call-1',
    });
    expect(r.debitado).toBe(true);
    // 100 centavos de USD a 5,00 = 500 centavos de real. Saldo 1 - 500 = -499.
    expect(r.debitoReaisCents).toBe(500);
    expect(r.saldoRestanteReaisCents).toBe(1 - 500);
  });

  it('um custo que arredonda para zero ainda debita 1 centavo', async () => {
    const cliente = clienteFalso(1_000);
    const r = await debitarChamadaDeIa(cliente, {
      organizationId: 'org-1',
      ...INSTALACAO,
      custoOrigemCents: 1,
      taxaBrlPorUnidade: 0.4,
      llmCallId: 'call-1',
    });
    expect(r.debitoReaisCents).toBe(1);
  });
});