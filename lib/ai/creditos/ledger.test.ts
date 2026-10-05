/**
 * O LIVRO-RAZÃO DA CARTEIRA — o contrato das linhas, sem banco.
 *
 * ═══ POR QUE LEDGER E NÃO SÓ SALDO ═══
 *
 * `ai_credit_balances.balance_cents` é o saldo CORRENTE, atualizado a cada
 * débito. O extrato é `ai_credit_ledger`, e é ele que responde "quanto foi
 * realmente cobrado e por quê". Um saldo sem extrato é um número que ninguém
 * pode auditar; um extrato sem saldo é lento demais para o caminho quente.
 *
 * A tabela `loyalty_ledger` do mesmo banco já escreveu a li: "LEDGER, não saldo.
 * O saldo do cliente é sum(points) e nunca uma coluna: guardar o saldo faria o
 * primeiro estorno divergir em silêncio." Aqui o saldo É coluna — porque o
 * débito precisa de `FOR UPDATE` numa linha, e somar o ledger inteiro no meio
 * do caminho quente seria reler a história a cada chamada. A diferença que
 * importa: o saldo é_cache_ do extrato, e cada linha do extrato é escrita na
 * MESMA transação do saldo. Divergir é impossível por construção, não por
 * disciplina.
 *
 * ═══ O SINAL É DERIVADO, NUNCA INFORMADO ═══
 *
 * `amount_cents` é ASSINADO, e o tipo do lançamento decide o sinal. Uma coluna
 * de "tipo" ao lado de uma coluna de "valor" sem sinal seria a segunda forma de
 * dizer a mesma coisa — e as duas divergem no primeiro estorno escrito à pressa.
 * Os construtores daqui recebem sempre valor POSITIVO e aplicam o sinal; é o
 * que torna impossível gravar um débito de +10.
 */
import { describe, expect, it } from 'vitest';

import {
  SALDO_DO_LANCAMENTO,
  TIPOS_DE_LANCAMENTO,
  linhaDeDebito,
  linhaDeRecarga,
  saldoDasLinhas,
  valorDaLinha,
} from '@/lib/ai/creditos/ledger';

describe('o catálogo de lançamentos', () => {
  it('cobre entrada, saída e correção — e nada além disso', () => {
    expect(TIPOS_DE_LANCAMENTO).toEqual(['recharge', 'debit', 'refund', 'adjustment']);
  });

  it('⚠️ a recarga é a ÚNICA que entra — só ela aumenta o saldo', () => {
    // Uma tabela de sinal por tipo é a forma de a regra ser legível sem ler o
    // código. Se um dia existir um tipo que credita, ele nasce aqui e não em
    // um `if` espalhado pelo repositório.
    const queEntra = TIPOS_DE_LANCAMENTO.filter((t) => SALDO_DO_LANCAMENTO[t] === 'entra');
    expect(queEntra).toEqual(['recharge']);
  });

  it('um tipo fora do catálogo não tem sinal definido', () => {
    expect(SALDO_DO_LANCAMENTO['inventado' as 'debit']).toBeUndefined();
  });
});

describe('construtor de débito', () => {
  const debito = linhaDeDebito({
    custoOrigemCents: 2,
    taxaBrlPorUnidade: 5,
    llmCallId: 'call-1',
    descricao: 'agent_turn',
  })!;

  it('o valor gravado é NEGATIVO: consome a carteira', () => {
    expect(debito.amount_cents).toBe(-10);
  });

  it('o custo em dólar fica preservado, com a moeda dele declarada', () => {
    // O extrato precisa responder "cobramos R$0,10 por quê" — e a resposta
    // honesta é "US$ 0,02 a 5,00", não um número solto.
    expect(debito.source_amount_cents).toBe(2);
    expect(debito.currency).toBe('USD');
  });

  it('a taxa fica CONGELADA na linha, em micros', () => {
    expect(debito.fx_rate_micros).toBe(5_000_000);
  });

  it('o lançamento aponta para a chamada que o causou', () => {
    expect(debito.llm_call_id).toBe('call-1');
    expect(debito.kind).toBe('debit');
  });

  it('custo zero NÃO gera linha de débito — nada de dinheiro movimento', () => {
    // Modelos gratuitos geram milhões de chamadas. Gravar um lançamento de 0
    // para cada uma enche o extrato de ruído e não muda saldo nenhum.
    expect(linhaDeDebito({ custoOrigemCents: 0, taxaBrlPorUnidade: 5, llmCallId: 'c' })).toBeNull();
  });

  it('a linha é constructed só com campos declarados — nada de segredo', () => {
    // Nenhuma chave, token ou conteúdo de mensagem pode entrar no ledger: ele é
    // lido por tela de cobrança e por gente de suporte.
    expect(Object.keys(debito).sort()).toEqual(
      [
        'amount_cents',
        'currency',
        'description',
        'fx_rate_micros',
        'kind',
        'llm_call_id',
        'recharge_id',
        'source_amount_cents',
      ].sort(),
    );
  });
});

describe('construtor de recarga', () => {
  const recarga = linhaDeRecarga({
    valorReaisCents: 5_000,
    descricao: 'recarga manual do dono',
    actorUserId: 'user-1',
  });

  it('o valor gravado é POSITIVO: entra dinheiro', () => {
    expect(recarga.amount_cents).toBe(5_000);
  });

  it('a moeda do saldo é a da carteira, e o custo de origem é nulo', () => {
    // Não houve custo em dólar: houve real. Preencher `source_amount_cents`
    // com o valor em real seria dizer que R$ 50,00 custaram US$ 50,00.
    expect(recarga.currency).toBe('BRL');
    expect(recarga.source_amount_cents).toBeNull();
  });

  it('a taxa congelada de uma recarga é 1:1 — real não se reconverte em real', () => {
    expect(recarga.fx_rate_micros).toBe(1_000_000);
  });

  it('⚠️ recarga de valor zero ou negativo é recusada na entrada', () => {
    // Recarga negativa é um estorno com o nome de recarga — e um estorno que
    // passa por aqui entra como crédito novo, com extrato mentindo.
    expect(() => linhaDeRecarga({ valorReaisCents: 0, descricao: 'x' })).toThrow(/reais/i);
    expect(() => linhaDeRecarga({ valorReaisCents: -100, descricao: 'x' })).toThrow(/reais/i);
    expect(() => linhaDeRecarga({ valorReaisCents: 10.5, descricao: 'x' })).toThrow(/reais/i);
  });

  it('um valor grande continua exato — a carteira não tem teto', () => {
    // Um self-hoster que fatura alto carrega a carteira num único pagamento.
    // O número precisa passar intacto, sem perder centavo em ponto flutuante.
    const linha = linhaDeRecarga({
      valorReaisCents: 100_000_000_00, // R$ 100.000,00
      descricao: 'compra grande do ano',
    });
    expect(linha.amount_cents).toBe(100_000_000_00);
  });
});

describe('a soma do extrato', () => {
  it('saldo das linhas é a soma dos sinais — a identidade que faz a coluna ser cache', () => {
    const linhas = [
      linhaDeRecarga({ valorReaisCents: 10_000, descricao: 'recarga' }),
      linhaDeDebito({ custoOrigemCents: 2, taxaBrlPorUnidade: 5, llmCallId: 'a' })!,
      linhaDeDebito({ custoOrigemCents: 4, taxaBrlPorUnidade: 5, llmCallId: 'b' })!,
    ];
    // 10.000 − 10 − 20 = 9.970 centavos de real.
    expect(saldoDasLinhas(linhas)).toBe(9_970);
  });

  it('um extrato vazio vale zero — e zero é o que trava a IA da instalação', () => {
    expect(saldoDasLinhas([])).toBe(0);
  });

  it('⚠️ duas recargas e um estorno dão o saldo que o dono espera ver', () => {
    const linhas = [
      linhaDeRecarga({ valorReaisCents: 10_000, descricao: 'primeira compra' }),
      linhaDeRecarga({ valorReaisCents: 10_000, descricao: 'segunda compra' }),
      {
        kind: 'refund' as const,
        amount_cents: -2_500,
        currency: 'BRL' as const,
        source_amount_cents: null,
        fx_rate_micros: 1_000_000,
        llm_call_id: null,
        recharge_id: null,
        description: 'estorno do pagamento',
      },
    ];
    expect(valorDaLinha(linhas[2]!)).toBe(-2_500);
    expect(saldoDasLinhas(linhas)).toBe(17_500);
  });
});