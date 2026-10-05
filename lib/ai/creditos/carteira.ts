/**
 * A CARTEIRA DE CRÉDITO DE IA — a matemática do dinheiro, sem banco.
 *
 * ═══ O QUE ESTA CARTEIRA É, E O QUE ELA NÃO É ═══
 *
 * Ela é um SALDO de crédito PAGO. Ela não é o teto de gasto do mês: esse mora
 * em `ai_budgets.monthly_limit_cents` e é decidido por
 * `lib/agent-engine/edge/llm/orcamento.ts`. Confundir os dois é o defeito mais
 * caro possível aqui, porque os dois respondem à mesma pergunta ("esta chamada
 * pode sair?") com sinais trocados:
 *
 *   - o TETO é um limite de GASTO que a organização escolhe e que zera virando o
 *     mês; ele tem aviso antes de parar, e parar é reversível subindo o limite;
 *   - o SALDO é DINHEIRO que a pessoa já pagou; ele não avisa antes de zerar
 *     (aviso de saldo zerado é aviso de que a IA já morreu), e só se recupera
 *     recarregando.
 *
 * ⚠️ Ordem de leitura errada entre os dois produz a pior falha possível: tratar
 * o saldo como "teto" e avisar antes de bloquear deixa a IA falar de graça até o
 * fim do mês com o dinheiro da instalação já todo Airborne; tratar o teto como
 * "saldo" bloqueia organizations que nunca escolheram limite nenhum.
 *
 * ═══ POR QUE A CONVERSÃO É CONGELADA ═══
 *
 * `llm_calls.cost_cents` é USD (ver `lib/agent-engine/edge/llm/pricing.ts`) e a
 * recarga é BRL. A taxa que vale é a do INSTANTE DA CHAMADA, gravada na linha do
 * ledger como micros inteiros. Recalcular o histórico com a taxa de hoje
 * reescreve o passado: o saldo de ontem deixa de bater com o extrato de ontem,
 * e quem confia no saldo perde a confiança na carteira inteira — sem nenhum erro
 * aparecer em lugar nenhum.
 *
 * Por isso o saldo é sempre BRL, e o USD só existe na linha do ledger, com a
 * taxa que o virou. Uma coluna de saldo em USD obrigaria aorges de quem recarrega
 * a pensar em câmbio; uma em BRL com o USD preservado no extrato não.
 *
 * Este módulo é PURO: zero banco, zero rede, zero relógio. `agora`, quando
 * qualquer dia precisar dele, é argumento.
 */
import { z } from 'zod';

/** A carteira é em real — é a moeda que a pessoa paga na cobrança. */
export const MOEDA_DA_CARTEIRA = 'BRL' as const;

/**
 * Moedas que podem aparecer na coluna `currency` de uma linha de ledger: a de
 * ORIGEM do número. O saldo nunca sai de BRL; o USD entra só como procedência
 * do débito.
 */
export const MOEDAS_ACEITAS = ['USD', 'BRL'] as const;

export type MoedaAceita = (typeof MOEDAS_ACEITAS)[number];

/**
 * A moeda de um custo de chamada é USD por omissão, porque é o que
 * `llm_calls.cost_cents` é (`pricing.ts` calcula em USD). Declarar isso como
 * default, e não como obrigação de quem chama, é o que impede o erro silencioso
 * de passar real como se fosse dólar.
 */
export const MOEDA_PADRAO_DO_CUSTO: MoedaAceita = 'USD';

/** Micros por unidade — a taxa congelada é inteira, nunca float em disco. */
const MICROS_POR_UNIDADE = 1_000_000;

/**
 * O PISO DE UM CENTAVO. Um custo não-nulo que arredonda para zero de real ainda
 * consome 1 centavo: sem este piso, uma taxa de câmbio despencando transforma
 * chamada em NÃO-cobrança, e o defeito aparece só na conciliação — nunca como
 * erro. O piso é o que mantém "toda chamada com preço custa alguma coisa" uma
 * verdade, e não uma intenção.
 */
export const PISO_DE_DEBITO_REAIS_CENTS = 1;

const taxaSchema = z
  .number({ message: 'taxa de câmbio inválida' })
  .refine((v) => Number.isFinite(v), { message: 'taxa de câmbio precisa ser um número finito' })
  .refine((v) => v > 0, { message: 'taxa de câmbio precisa ser maior que zero' });

const custoSchema = z
  .number({ message: 'custo inválido' })
  .refine((v) => Number.isFinite(v), { message: 'custo precisa ser um número finito' })
  .refine((v) => Number.isInteger(v), { message: 'custo precisa ser um número inteiro de centavos' })
  .refine((v) => v >= 0, { message: 'custo não pode ser negativo — devolução é lançamento de estorno' });

const moedaSchema = z.enum(MOEDAS_ACEITAS, { message: 'moeda de origem não suportada' }).default(
  MOEDA_PADRAO_DO_CUSTO,
);

/**
 * A taxa congelada, em micros de real por unidade da moeda de origem.
 *
 * `Math.round`, não `toFixed`: `toFixed` devolve STRING e devolve `NaN` em vez de
 * falhar, o que transforma uma taxa quebrada num saldo silenciosamente errado.
 * `Number.isFinite` antes, porque o único jeito de um `Infinity` chegar aqui é
 * config de taxa escrita à mão, e `Infinity * 0` é `NaN` — que some em silêncio
 * dentro de uma soma.
 */
export function microssDaTaxa(taxaBrlPorUnidade: number): number {
  const taxa = taxaSchema.parse(taxaBrlPorUnidade);
  return Math.round(taxa * MICROS_POR_UNIDADE);
}

export interface EntradaDaConversao {
  /** `llm_calls.cost_cents` — centavo da moeda de ORIGEM. `0` = modelo grátis. */
  custoOrigemCents: number;
  /** De onde vem o número de cima. Default: USD, a moeda de `cost_cents`. */
  moedaOrigem?: MoedaAceita;
  /** Quantos reais por 1 unidade da moeda de origem. Ignorada quando `BRL`. */
  taxaBrlPorUnidade: number;
}

export interface ConversaoDeCredito {
  /** O custo como veio, na moeda de origem. Preservado para o extrato. */
  custoOrigemCents: number;
  moedaOrigem: MoedaAceita;
  /** O que SAI da carteira: centavos de REAL, sempre positivo. */
  debitoReaisCents: number;
  /** A taxa que produziu o débito, congelada em micros. */
  microssDaTaxa: number;
}

/**
 * Converte o custo de uma chamada no débito da carteira, em uma única
 * passagem. A taxa entra CONGELADA: o resultado não depende de quando esta
 * função é chamada, e é por isso que ela pode ser reexecutada sobre uma linha
 * antiga sem mudar o passado.
 *
 * ⚠️ Quando a moeda de origem JÁ é a da carteira, a taxa não entra na conta —
 * converter real em real a uma taxa qualquer produziria um saldo que não é o
 * saldo que a pessoa pagou. O `microssDaTaxa` gravado é 1:000000, que é a
 * verdade, e não um valor inventado para preencher coluna.
 */
export function converterCredito(entrada: EntradaDaConversao): ConversaoDeCredito {
  const custoOrigemCents = custoSchema.parse(entrada.custoOrigemCents);
  const moedaOrigem = moedaSchema.parse(entrada.moedaOrigem);
  // A taxa é validada MESMO quando o custo é zero: uma taxa quebrada é um bug de
  // configuração, e descobrir isso na primeira chamada de verdade — em vez de na
  // validação — é a forma cara de descobrir.
  const taxaInformada = taxaSchema.parse(entrada.taxaBrlPorUnidade);

  const naMoedaDaCarteira = moedaOrigem === MOEDA_DA_CARTEIRA;
  const micros = naMoedaDaCarteira ? MICROS_POR_UNIDADE : microssDaTaxa(taxaInformada);

  // Escala em MICROS antes de dividir: o arredondamento meio-para-cima de
  // `(custo * taxa)` em float erra na fronteira, e o erro se repete a cada
  // chamada da mesma magnitude. Com micros, o produto é inteiro até o fim.
  const debitoBruto = (custoOrigemCents * micros) / MICROS_POR_UNIDADE;
  const arredondado = Math.round(debitoBruto);
  const debitoReaisCents =
    custoOrigemCents > 0 && arredondado < PISO_DE_DEBITO_REAIS_CENTS
      ? PISO_DE_DEBITO_REAIS_CENTS
      : arredondado;

  return {
    custoOrigemCents,
    moedaOrigem,
    debitoReaisCents,
    microssDaTaxa: micros,
  };
}

/**
 * O saldo PARA A CHAMADA ou para o NADA.
 *
 * ⚠️ `null` (não deu para ler) NÃO bloqueia, e a distinção com `0` é o ponto
 * inteiro desta função. Um clone cujo `update.sh` não aplicou a migration
 * devolveria `0` se o gate tratasse ausência como zero — e a IA calaria sem
 * nenhum caminho de volta. `null` é "não deu para saber"; a resposta de quem não
 * sabe é deixar passar e GRITAR no log, porque o dinheiro que se perde é de
 * poucos centavos e o WhatsApp que se perde é do cliente.
 *
 * Idem para número inválido (`NaN`, `undefined`): entra como `null`, nunca
 * como `0`, pelo mesmo motivo.
 */
export function saldoEhBloqueante(saldo: number | null | undefined): boolean {
  if (typeof saldo !== 'number' || !Number.isFinite(saldo)) return false;
  return saldo <= 0;
}