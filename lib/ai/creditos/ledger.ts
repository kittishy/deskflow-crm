/**
 * O LIVRO-RAZÃO DA CARTEIRA DE CRÉDITO — o contrato das linhas, sem banco.
 *
 * ═══ LEDGER E SALDO, E POR QUE ESTE REPOSITÓRIO TEM OS DOIS ═══
 *
 * `ai_credit_balances.balance_cents` é o saldo CORRENTE. `ai_credit_ledger` é o
 * extrato. A `loyalty_ledger` do mesmo banco escreveu a li do caso sem saldo:
 * "LEDGER, não saldo. O saldo do cliente é sum(points) e nunca uma coluna:
 * guardar o saldo faria o primeiro estorno divergir em silêncio."
 *
 * A carteira é o caso COM saldo, e a razão é concreta: o débito acontece no
 * caminho quente de uma chamada de LLM, e precisa de uma LINHA para travar com
 * `SELECT ... FOR UPDATE`. Somar o extrato inteiro ali seria reler a história a
 * cada token, e sem trava a soma não é snapshot de nada.
 *
 * O que impede a divergência que a loyalty tema é o PAR: cada linha do extrato é
 * escrita na MESMA transação do saldo (ver `./gate.ts`). Não é disciplina, é
 * atomicidade — não existe instante em que os dois discordam porque não existe
 * instante em que só um deles mudou.
 *
 * ═══ O SINAL É DERIVADO DO TIPO, NUNCA INFORMADO ═══
 *
 * `amount_cents` é ASSINADO e o tipo do lançamento decide o sinal. Uma coluna de
 * "tipo" ao lado de um "valor" com o sinal em outro lugar seria a segunda forma
 * de dizer a mesma coisa — e as duas divergem no primeiro estorno escrito à
 * pressa. Os construtores daqui recebem valor POSITIVO e aplicam o sinal, o
 * que torna impossível gravar um débito de +10.
 *
 * Este módulo é PURO: as linhas são montadas aqui, o INSERT mora aqui como
 * constante (para que um teste de invariante execute ESTE texto), e nada toca o
 * banco em tempo de execução.
 */
import { z } from 'zod';

import {
  MOEDA_DA_CARTEIRA,
  MOEDAS_ACEITAS,
  converterCredito,
  microssDaTaxa,
  type MoedaAceita,
} from './carteira';

export const TIPOS_DE_LANCAMENTO = ['recharge', 'debit', 'refund', 'adjustment'] as const;

export type TipoDeLancamento = (typeof TIPOS_DE_LANCAMENTO)[number];

/**
 * Para onde o lançamento move o saldo. Só `recharge`(move para dentro) aumenta;
 * `debit` e `refund` tiram (o estorno devolve dinheiro a quem pagou), e
 * `adjustment` é a correção manual, cujo sinal é o que o autor escolheu — por
 * isso ele não aparece aqui: o sinal de um ajuste é dado pelo valor, e é o único
 * tipo em que isso é deliberado.
 */
export const SALDO_DO_LANCAMENTO = {
  recharge: 'entra',
  debit: 'sai',
  refund: 'sai',
  adjustment: 'definido_pelo_valor',
} as const satisfies Record<TipoDeLancamento, 'entra' | 'sai' | 'definido_pelo_valor'>;

export interface LinhaDeLancamento {
  kind: TipoDeLancamento;
  /** Centavos de REAL, ASSINADO. Positivo credita, negativo debita. */
  amount_cents: number;
  /** A moeda do `source_amount_cents` — de onde veio o número original. */
  currency: MoedaAceita;
  /** O valor original, na moeda de `currency`. `null` quando não houve conversão. */
  source_amount_cents: number | null;
  /** Taxa congelada em micros (reais por unidade da moeda de origem). */
  fx_rate_micros: number;
  llm_call_id: string | null;
  recharge_id: string | null;
  description: string | null;
}

/** A contribuição desta linha ao saldo. É a única definição de sinal do arquivo. */
export function valorDaLinha(linha: Pick<LinhaDeLancamento, 'amount_cents'>): number {
  return linha.amount_cents;
}

/**
 * O saldo que o extrato descreve. Existe para o teste de invariante comparar
 * com `ai_credit_balances.balance_cents` — e é a afirmação que a coluna é
 * CACHE do extrato, não uma segunda verdade.
 */
export function saldoDasLinhas(linhas: readonly LinhaDeLancamento[]): number {
  return linhas.reduce((total, linha) => total + valorDaLinha(linha), 0);
}

const valorReaisSchema = z
  .number({ message: 'valor em reais inválido' })
  .refine((v) => Number.isFinite(v), { message: 'valor em reais precisa ser um número finito' })
  .refine((v) => Number.isInteger(v), {
    message: 'valor em reais precisa ser um número inteiro de centavos',
  })
  .refine((v) => v > 0, { message: 'valor em reais precisa ser maior que zero' });

const motivoSchema = z
  .string({ message: 'motivo inválido' })
  .trim()
  .min(3, { message: 'motivo precisa dizer por que o dinheiro entrou' })
  .max(500, { message: 'motivo longo demais' });

/** Motivo é obrigatório e vai para o extrato: recarga sem rastro é dinheiro sem dono. */
export function validarMotivo(motivo: string): string {
  return motivoSchema.parse(motivo);
}

export function linhaDeDebito(entrada: {
  /** `llm_calls.cost_cents` — centavo de USD. `0` = modelo grátis. */
  custoOrigemCents: number;
  taxaBrlPorUnidade: number;
  llmCallId: string;
  descricao?: string | null;
}): LinhaDeLancamento | null {
  const conversao = converterCredito({
    custoOrigemCents: entrada.custoOrigemCents,
    taxaBrlPorUnidade: entrada.taxaBrlPorUnidade,
  });
  // Custo zero NÃO vira linha. Modelos gratuitos geram volume alto e cada
  // lançamento de 0 seria ruído no extrato sem mover saldo nenhum.
  if (conversao.debitoReaisCents === 0) return null;
  return {
    kind: 'debit',
    amount_cents: -conversao.debitoReaisCents,
    currency: conversao.moedaOrigem,
    source_amount_cents: conversao.custoOrigemCents,
    fx_rate_micros: conversao.microssDaTaxa,
    llm_call_id: entrada.llmCallId,
    recharge_id: null,
    description: entrada.descricao ?? null,
  };
}

export function linhaDeRecarga(entrada: {
  valorReaisCents: number;
  descricao: string;
  actorUserId?: string | null;
}): LinhaDeLancamento {
  const valor = valorReaisSchema.parse(entrada.valorReaisCents);
  const motivo = motivoSchema.parse(entrada.descricao);
  return {
    kind: 'recharge',
    amount_cents: valor,
    // A moeda do SALDO. `source_amount_cents` é nulo porque não houve conversão:
    // houve real, e preencher a coluna de origem com o mesmo número seria dizer
    // que R$ 50,00 custaram US$ 50,00.
    currency: MOEDA_DA_CARTEIRA,
    source_amount_cents: null,
    fx_rate_micros: 1_000_000,
    llm_call_id: null,
    recharge_id: null,
    description: motivo,
  };
}

/**
 * O INSERT do lançamento. Constante exportada, e não string montada em quem
 * chama, pelo mesmo motivo de `SQL_ORCAMENTO`: o invariante precisa executar
 * ESTE texto contra um Postgres real — medir a cópia seria medir a cópia.
 *
 * ⚠️ Não é `on conflict do nothing`: um lançamento de extrato duplicado é um
 * bug de código, e silenciá-lo devolveria saldo e extrato discordando sem
 * ninguém ver. A UNIQUE que protege a RECARGA é outra coisa e mora em
 * `./recarga.ts`, onde o duplicado é esperado.
 *
 * A ordem das colunas segue a ordem dos campos de `LinhaDeLancamento`, e quem
 * chama passa NESSA ordem — por isso a lista de parâmetros é fixada aqui, e não
 * montada em quem chama.
 */
export const SQL_INSERT_LANCAMENTO = `
  insert into public.ai_credit_ledger
    (organization_id, kind, amount_cents, currency, source_amount_cents,
     fx_rate_micros, llm_call_id, recharge_id, description)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  returning id`;

/** Os parâmetros do `SQL_INSERT_LANCAMENTO`, na ordem em que ele os consome. */
export function parametrosDoLancamento(
  organizationId: string,
  linha: LinhaDeLancamento,
): unknown[] {
  return [
    organizationId,
    linha.kind,
    linha.amount_cents,
    linha.currency,
    linha.source_amount_cents,
    linha.fx_rate_micros,
    linha.llm_call_id,
    linha.recharge_id,
    linha.description,
  ];
}

/**
 * Reexporta o que a carteira já squebrou, para quem só precisa montar o
 * lançamento não ter que saber de onde veio a matemática.
 */
export { MOEDAS_ACEITAS, MOEDA_DA_CARTEIRA, microssDaTaxa };
export type { MoedaAceita };