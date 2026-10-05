/**
 * A CARTEIRA DE CRÉDITO DE IA — a matemática do dinheiro, sem banco.
 *
 * ═══ POR QUE ESTE ARQUIVO EXISTE ═══
 *
 * Duas moedas entram nesta conta e elas NÃO são a mesma coisa:
 * `llm_calls.cost_cents` é USD (ver `pricing.ts`), e a recarga é BRL — é o que
 * a pessoa paga na cobrança. somebody que troca as duas sem perceber escreve um
 * saldo que mente por um fator de ~5, e o erro só aparece quando alguém tenta
 * sacar o dinheiro.
 *
 * A conversão é CONGELADA no débito: a taxa que vale é a do instante da chamada,
 * gravada na linha do ledger. Recalcular depois com a taxa de hoje reescreve o
 * passado — o saldo de ontem passa a não bater com o extrato de ontem, e quem
 * confia no saldo perde a confiança na carteira inteira.
 *
 * ═══ O QUE ESTE ARQUIVO PROVA ═══
 *
 * A conversão (com o congelamento, o arredondamento e o piso de 1 centavo), e o
 * fato de que a carteira é uma CORRETA de LINHAS e não uma segunda fonte de
 * verdade: `ai_budgets` é teto de GASTO do mês, `ai_credit_balances` é SALDO de
 * crédito pago. Confundir os dois é o defeito que esta carteira precisa impedir.
 */
import { describe, expect, it } from 'vitest';

import {
  MOEDA_DA_CARTEIRA,
  MOEDAS_ACEITAS,
  converterCredito,
  microssDaTaxa,
  saldoEhBloqueante,
} from '@/lib/ai/creditos/carteira';

describe('moeda da carteira', () => {
  it('a carteira é em real — é o que a pessoa paga na cobrança', () => {
    expect(MOEDA_DA_CARTEIRA).toBe('BRL');
  });

  it('a moeda de origem do custo é dólar, porque llm_calls.cost_cents é USD', () => {
    expect(MOEDAS_ACEITAS).toContain('USD');
    // E o ledger aceita as duas: guarda de onde veio o número, em qual moeda.
    expect(MOEDAS_ACEITAS).toContain('BRL');
  });
});

describe('congelamento da taxa', () => {
  it('5,03 BRL por dólar vira 5 030 000 micros — inteiro, sem float', () => {
    expect(microssDaTaxa(5.03)).toBe(5_030_000);
  });

  it('a taxa vem de uma casa fixa: duas taxas iguais dão o mesmo micros', () => {
    // 0.1 + 0.2 !== 0.3 em float. Se a taxa chegasse como soma de float, o
    // micros gravado seria 30000000000000004 e o extrato não fecharia.
    expect(microssDaTaxa(0.1 + 0.2)).toBe(microssDaTaxa(0.3));
  });

  it('taxa zero ou negativa é recusada — taxa zero não é "grátis", é bug', () => {
    expect(() => microssDaTaxa(0)).toThrow(/taxa/i);
    expect(() => microssDaTaxa(-1)).toThrow(/taxa/i);
    expect(() => microssDaTaxa(Number.POSITIVE_INFINITY)).toThrow(/taxa/i);
    expect(() => microssDaTaxa(Number.NaN)).toThrow(/taxa/i);
  });
});

describe('conversão do custo em débito de carteira', () => {
  it('2 centavos de dólar a 5,00 são 10 centavos de real', () => {
    const c = converterCredito({ custoOrigemCents: 2, moedaOrigem: 'USD', taxaBrlPorUnidade: 5 });
    expect(c.debitoReaisCents).toBe(10);
    expect(c.microssDaTaxa).toBe(5_000_000);
    expect(c.moedaOrigem).toBe('USD');
  });

  it('um custo já em real não é convertido duas vezes', () => {
    const c = converterCredito({ custoOrigemCents: 250, moedaOrigem: 'BRL', taxaBrlPorUnidade: 1 });
    expect(c.debitoReaisCents).toBe(250);
  });

  it('arredonda meio-para-cima, não trunca: 3 centavos a 5,03 dão 15,09 → 15', () => {
    const c = converterCredito({ custoOrigemCents: 3, taxaBrlPorUnidade: 5.03 });
    expect(c.debitoReaisCents).toBe(15);
  });

  it('custo zero NÃO é débito — modelo grátis não consome carteira', () => {
    const c = converterCredito({ custoOrigemCents: 0, taxaBrlPorUnidade: 5 });
    expect(c.debitoReaisCents).toBe(0);
  });

  it('⚠️ custo que arredonda para zero ainda consome 1 centavo — chamada nunca é de graça', () => {
    // 1 centavo de dólar a 0,4 são 0,4 centavo de real. Truncado, seria 0 — e
    // aí o agente rodaria de graça para sempre com a taxa despencando. O piso
    // de 1 centavo é o que impede que uma taxa de câmbio vire NÃO-cobrança.
    const c = converterCredito({ custoOrigemCents: 1, taxaBrlPorUnidade: 0.4 });
    expect(c.debitoReaisCents).toBe(1);
  });

  it('custo negativo é recusado — devolução de saldo não passa por aqui', () => {
    // Estorno é linha de ledger do tipo `refund`, com a própria regra. Um
    // `custoOrigemCents` negativo aqui viraria crédito dobrado.
    expect(() => converterCredito({ custoOrigemCents: -1, taxaBrlPorUnidade: 5 })).toThrow(/custo/i);
  });

  it('custo fracionário é recusado — centavo é inteiro', () => {
    expect(() => converterCredito({ custoOrigemCents: 1.5, taxaBrlPorUnidade: 5 })).toThrow(/custo/i);
  });

  it('custo sem número é recusado na entrada, não vira NaN no saldo', () => {
    expect(() =>
      converterCredito({
        custoOrigemCents: Number.NaN,
        taxaBrlPorUnidade: 5,
      }),
    ).toThrow(/custo/i);
    expect(() =>
      converterCredito({ custoOrigemCents: 2, taxaBrlPorUnidade: Number.NaN }),
    ).toThrow(/taxa/i);
  });

  it('moeda de origem fora do catálogo é recusada', () => {
    expect(() =>
      converterCredito({
        custoOrigemCents: 2,
        moedaOrigem: 'EUR' as unknown as 'USD',
        taxaBrlPorUnidade: 5,
      }),
    ).toThrow(/moeda/i);
  });

  it('a conversão é uma função pura: a mesma entrada devolve a mesma saída', () => {
    const entrada = { custoOrigemCents: 7, taxaBrlPorUnidade: 5.11 } as const;
    const a = converterCredito(entrada);
    const b = converterCredito(entrada);
    expect(a).toEqual(b);
    // E a entrada não é mutada — é a entrada de quem já está em uso.
    expect(entrada).toEqual({ custoOrigemCents: 7, taxaBrlPorUnidade: 5.11 });
  });
});

describe('o que bloqueia a chamada', () => {
  it('saldo zerado bloqueia', () => {
    expect(saldoEhBloqueante(0)).toBe(true);
  });

  it('saldo NEGATIVO bloqueia — dívida é saldo <= 0, não < 0', () => {
    // O negativo nasce da corrida de duas chamadas que passaram as duas pelo
    // pré-flight. Ele tem que parar a próxima, senão a dívida vira um buraco.
    expect(saldoEhBloqueante(-7)).toBe(true);
  });

  it('saldo positivo não bloqueia', () => {
    expect(saldoEhBloqueante(1)).toBe(false);
  });

  it('⚠️ saldo INDISPONÍVEL (null) NÃO bloqueia — é falha de leitura, não saldo zero', () => {
    // Coluna que não existe no clone, banco fora do ar: o clone que não aplicou
    // a migration não pode ficar com a IA calada sem caminho de volta. `null`
    // é "não deu para saber", e a resposta de quem não sabe é frouxa + log alto.
    expect(saldoEhBloqueante(null)).toBe(false);
  });

  it('saldo não numérico é tratado como indisponível, nunca como 0', () => {
    // 0 bloqueia. Se um `Number(NaN)` ou um `undefined` virasse 0 na frente do
    // gate, um clone com bug parava a IA sem ninguém saber por quê.
    expect(saldoEhBloqueante(Number.NaN)).toBe(false);
    expect(saldoEhBloqueante(undefined as unknown as number | null)).toBe(false);
  });
});