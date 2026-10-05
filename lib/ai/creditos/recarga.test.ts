/**
 * A RECARGA — entrada de dinheiro na carteira, e a idempotência que a protege.
 *
 * ═══ DOIS CAMINHOS, UMA REGRA ═══
 *
 * Hoje a entrada de dinheiro é MANUAL: o dono da instalação credita. Amanhã há
 * um webhook de pagamento (o Asaas já aparece no produto), e ele é entregue no
 * mesmo dia em que o provedor reenvia. Um provedor de pagamento reenvia webhook —
 * é comportamento normal dele, não defeito. Sem proteção, o reenvio credita duas
 * vezes e o dono paga por um saldo que não recebeu.
 *
 * A proteção é a UNIQUE de `ai_credit_recharges.external_payment_id`, e ela é
 * GLOBAL, não por organização. Um id de pagamento do provedor é global: a mesma
 * linha chegando com outra `organization_id` é exatamente o caso que não pode
 * passar, e uma UNIQUE por org deixaria esse caso passar.
 *
 * A referência de desenho é `loyalty_ledger.idempotency_key`, no mesmo banco, e o
 * nome dela é a regra: o dono decide creditar, o sistema decide se já creditou.
 */
import { describe, expect, it } from 'vitest';

import {
  aplicarPagamentoDeCredito,
  recarregarManualmente,
  type ClienteDeCredito,
} from '@/lib/ai/creditos/recarga';

/** `organization_id` é uuid no schema — e a validação na entrada cobra isso. */
const ORG_1 = '11111111-1111-4111-8111-111111111111';
const ORG_2 = '22222222-2222-4222-8222-222222222222';

function clienteFalso(saldoInicial = 0) {
  const executados: { sql: string; params: unknown[] }[] = [];
  const idsDePagamento = new Set<string>();
  let saldo = saldoInicial;
  return {
    executados,
    saldoAtual: () => saldo,
    async query(text: string, params: unknown[] = []) {
      executados.push({ sql: text, params });
      if (/for update/i.test(text)) return { rows: [{ id: 'saldo-1', balance_cents: saldo }], rowCount: 1 };
      if (/insert\s+(into\s+)?(public\.)?ai_credit_recharges/i.test(text)) {
        const id = String(params[1]);
        if (idsDePagamento.has(id)) return { rows: [], rowCount: 0 }; // a UNIQUE estourou
        idsDePagamento.add(id);
        return { rows: [{ id: 'recharge-1' }], rowCount: 1 };
      }
      if (/update\s+(public\.)?ai_credit_balances/i.test(text)) {
        saldo += Number(params[1] ?? 0);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

type Alvo = ClienteDeCredito & { executados: { sql: string; params: unknown[] }[] };

const alvo = (c: ReturnType<typeof clienteFalso>): Alvo => c;

/** `begin`/`commit`/`rollback` não são SQL de carteira: ficam de fora da lista. */
const sqlDeCarteira = (c: ReturnType<typeof clienteFalso>) =>
  c.executados.filter((q) => /ai_credit_|llm_calls/i.test(q.sql));

describe('recarga manual, pelo dono', () => {
  it('credita o valor e responde o saldo novo', async () => {
    const db = clienteFalso(100);
    const r = await recarregarManualmente(alvo(db), {
      organizationId: ORG_1,
      valorReaisCents: 5_000,
      motivo: 'recarga manual do dono',
      actorUserId: 'user-1',
    });
    expect(r.aplicada).toBe(true);
    expect(r.valorReaisCents).toBe(5_000);
    expect(r.saldoReaisCents).toBe(5_100);
    expect(db.saldoAtual()).toBe(5_100);
  });

  it('valida o valor ANTES de tocar no banco', async () => {
    const db = clienteFalso(0);
    for (const valor of [0, -1, 1.5, Number.NaN]) {
      await expect(
        recarregarManualmente(alvo(db), {
          organizationId: ORG_1,
          valorReaisCents: valor,
          motivo: 'recarga invalida',
        }),
      ).rejects.toThrow(/reais/i);
    }
    // Nenhum SQL de carteira foi emitido: recarga inválida não é meia recarga.
    expect(sqlDeCarteira(db)).toHaveLength(0);
  });

  it('sem organizationId valido não recarrega — a org vem de fonte confiável', async () => {
    const db = clienteFalso(0);
    await expect(
      recarregarManualmente(alvo(db), {
        organizationId: 'org-1',
        valorReaisCents: 100,
        motivo: 'recarga invalida',
      }),
    ).rejects.toThrow(/organiza/i);
    expect(sqlDeCarteira(db)).toHaveLength(0);
  });

  it('o motivo é obrigatório — recarga sem rastro é dinheiro sem dono', async () => {
    const db = clienteFalso(0);
    for (const motivo of ['', '   ', 'x']) {
      await expect(
        recarregarManualmente(alvo(db), {
          organizationId: ORG_1,
          valorReaisCents: 100,
          motivo,
        }),
      ).rejects.toThrow(/motivo/i);
    }
    expect(sqlDeCarteira(db)).toHaveLength(0);
  });

  it('o lançamento manual não finge vir de pagamento externo', async () => {
    const db = clienteFalso(0);
    await recarregarManualmente(alvo(db), {
      organizationId: ORG_1,
      valorReaisCents: 100,
      motivo: 'credito de boa-vinda',
    });
    // Nenhum id de pagamento é inventado: a recarga manual não tem um, e
    // fabricar um faria o webhook futuro casar com ela.
    expect(sqlDeCarteira(db).some((q) => /ai_credit_recharges/i.test(q.sql))).toBe(false);
  });

  it('abre e fecha uma transação — o crédito não pode ficar pela metade', async () => {
    const db = clienteFalso(0);
    await recarregarManualmente(alvo(db), {
      organizationId: ORG_1,
      valorReaisCents: 100,
      motivo: 'recarga com transacao',
    });
    expect(db.executados[0]!.sql.trim()).toBe('begin');
    expect(db.executados.at(-1)!.sql.trim()).toBe('commit');
  });
});

describe('pagamento recebido — o caminho do webhook futuro', () => {
  const PAGAMENTO = {
    externalPaymentId: 'asaas_12345',
    organizationId: ORG_1,
    valorReaisCents: 2_000,
    provider: 'asaas',
  };

  it('aplica uma vez e credita', async () => {
    const db = clienteFalso();
    const r = await aplicarPagamentoDeCredito(alvo(db), PAGAMENTO);
    expect(r).toMatchObject({ aplicada: true, duplicada: false, valorReaisCents: 2_000 });
    expect(db.saldoAtual()).toBe(2_000);
  });

  it('o MESMO pagamento duas vezes credita uma vez só', async () => {
    // Esta é a linha que justifica a UNIQUE. Reenvio de webhook é rotina do
    // provedor de pagamento; sem isto, o dono paga duas vezes pelo mesmo saldo.
    const db = clienteFalso();
    const primeiro = await aplicarPagamentoDeCredito(alvo(db), PAGAMENTO);
    const segundo = await aplicarPagamentoDeCredito(alvo(db), PAGAMENTO);
    expect(primeiro.aplicada).toBe(true);
    expect(segundo.aplicada).toBe(false);
    expect(segundo.duplicada).toBe(true);
    expect(db.saldoAtual()).toBe(2_000);
  });

  it('a duplicata NÃO toca o saldo nem o extrato', async () => {
    const db = clienteFalso();
    await aplicarPagamentoDeCredito(alvo(db), PAGAMENTO);
    const antes = db.executados.length;
    await aplicarPagamentoDeCredito(alvo(db), PAGAMENTO);
    const depois = sqlDeCarteira({
      ...db,
      executados: db.executados.slice(antes),
    } as ReturnType<typeof clienteFalso>);
    // Só o INSERT da recharge, que é o que Discover a duplicata. Sem trava de
    // saldo, sem UPDATE, sem lançamento: a duplicata não é meia recarga.
    expect(depois).toHaveLength(1);
    expect(depois[0]!.sql).toMatch(/ai_credit_recharges/i);
  });

  it('o mesmo id com outra organização também é recusado — o id é global', async () => {
    const db = clienteFalso();
    await aplicarPagamentoDeCredito(alvo(db), PAGAMENTO);
    const sequestro = await aplicarPagamentoDeCredito(alvo(db), {
      ...PAGAMENTO,
      organizationId: ORG_2,
    });
    expect(sequestro.aplicada).toBe(false);
    expect(db.saldoAtual()).toBe(2_000);
  });

  it('o id do pagamento é obrigatório e limitado — ele vai para o log e para a tela', async () => {
    const db = clienteFalso();
    for (const id of ['', '   ', 'x'.repeat(300)]) {
      await expect(
        aplicarPagamentoDeCredito(alvo(db), { ...PAGAMENTO, externalPaymentId: id }),
      ).rejects.toThrow(/pagamento/i);
    }
    expect(sqlDeCarteira(db)).toHaveLength(0);
  });

  it('o valor do pagamento é validado como na recarga manual', async () => {
    const db = clienteFalso();
    await expect(
      aplicarPagamentoDeCredito(alvo(db), { ...PAGAMENTO, valorReaisCents: 0 }),
    ).rejects.toThrow(/reais/i);
    expect(sqlDeCarteira(db)).toHaveLength(0);
  });

  it('o lançamento aponta para a linha da recarga, não para o id do pagamento', async () => {
    const db = clienteFalso();
    await aplicarPagamentoDeCredito(alvo(db), PAGAMENTO);
    const lancamento = sqlDeCarteira(db).find((q) => /ai_credit_ledger/i.test(q.sql));
    // O extrato liga na LINHA da recarga (chave estrangeira, auditável), e o id
    // do provedor fica onde ele é consultável: em `ai_credit_recharges`.
    expect(lancamento?.params).toContain('recharge-1');
    expect(lancamento?.params).not.toContain('asaas_12345');
  });
});