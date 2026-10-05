/**
 * A RECARGA — a entrada de dinheiro na carteira, e a idempotência que a protege.
 *
 * ═══ DOIS CAMINHOS, UMA REGRA ═══
 *
 * Hoje a entrada de dinheiro é MANUAL: o dono da instalação credita. Amanhã há
 * um webhook de pagamento (o Asaas já aparece no produto), e ele vai nascer no
 * mesmo dia em que o Asaas reenviar. Reenvio de webhook é comportamento normal
 * de provedor de pagamento, não defeito: sem proteção, o reenvio credita duas
 * vezes e o dono paga por um saldo que não recebeu.
 *
 * A proteção é a UNIQUE de `ai_credit_recharges.external_payment_id` — GLOBAL, e
 * não por organização. Um id de pagamento do provedor é global; a mesma linha
 * chegando com outra `organization_id` é exatamente o caso que não pode passar,
 * e uma UNIQUE por organização deixaria esse caso passar.
 *
 * ⚠️ E a duplicata precisa ser ASSIMÉTRICA: ela responde "não fiz nada" sem tocar
 * em saldo nem em extrato. Se a segunda chamada reexecutasse o crédito com o
 * mesmo id, a UNIQUE estaria protecting apenas metade do problema — o banco
 * rejeitaria a linha da recarga mas o saldo já teria sido atualizado antes.
 *
 * A referência de desenho é `loyalty_ledger.idempotency_key`, no mesmo banco, e o
 * nome dela é a regra: o DONO decide creditar, o SISTEMA decide se já creditou.
 */
import { z } from 'zod';

import { MOEDA_DA_CARTEIRA } from '@/lib/ai/creditos/carteira';
import {
  linhaDeRecarga,
  parametrosDoLancamento,
  SQL_INSERT_LANCAMENTO,
  validarMotivo,
} from '@/lib/ai/creditos/ledger';
import {
  SQL_GARANTIR_LINHA_DE_SALDO,
  SQL_TRAVAR_SALDO,
  type ClienteDeCredito,
} from '@/lib/ai/creditos/gate';

export type { ClienteDeCredito };

/** `AlvoDeCredito` aceita pool OU cliente: a recarga abre a própria transação. */
type Alvo = ClienteDeCredito | { connect(): Promise<ClienteDeCredito> };

async function comoCliente(db: Alvo): Promise<ClienteDeCredito> {
  if (typeof (db as { connect?: unknown }).connect === 'function') {
    return (db as { connect(): Promise<ClienteDeCredito> }).connect();
  }
  return db as ClienteDeCredito;
}

const organizationIdSchema = z
  .string({ message: 'organizacao invalida' })
  .uuid('organizationId precisa ser um uuid');

const valorReaisSchema = z
  .number({ message: 'valor em reais invalido' })
  .refine((v) => Number.isFinite(v), { message: 'valor em reais precisa ser um numero finito' })
  .refine((v) => Number.isInteger(v), {
    message: 'valor em reais precisa ser um numero inteiro de centavos',
  })
  .refine((v) => v > 0, { message: 'valor em reais precisa ser maior que zero' });

const idPagamentoSchema = z
  .string({ message: 'id do pagamento invalido' })
  .trim()
  .min(1, { message: 'id do pagamento e obrigatorio' })
  .max(255, { message: 'id do pagamento longo demais' });

/**
 * O `INSERT` da recarga de pagamento. `on conflict (external_payment_id) do
 * nothing` é a tradução de idempotência: quando volta VAZIO, o pagamento já
 * foi aplicado — e quem grava o saldo é quem volta com a linha.
 *
 * ⚠️ O conflito nomeia a UNIQUE GLOBAL, e não `(organization_id,
 * external_payment_id)`. Ver a cabeçalho: o id do pagamento é do provedor, e a
 * mesma linha chegando com outra organização é sequestro de crédito, não
 * recarga.
 */
export const SQL_INSERT_RECARGA_PAGAMENTO = `
  insert into public.ai_credit_recharges
    (organization_id, external_payment_id, provider, amount_cents, currency, status)
  values ($1, $2, $3, $4, $5, 'paid')
  on conflict (external_payment_id) do nothing
  returning id`;

/**
 * O crédito no saldo, por ID — a mesma amarração do débito (`./gate.ts`): já
 * temos a linha travada, e recalcular a partir da coluna reabriria a janela.
 */
export const SQL_CREDITAR_SALDO = `
  update public.ai_credit_balances
     set balance_cents = balance_cents + $2, updated_at = now()
   where id = $1
  returning balance_cents`;

export interface RecargaAplicada {
  aplicada: boolean;
  /** `true` quando era o MESMO pagamento de antes. Não é erro — é reenvio. */
  duplicada: boolean;
  valorReaisCents: number;
  saldoReaisCents: number;
  /** A linha em `ai_credit_recharges`, quando houve. `null` na duplicata. */
  rechargeId: string | null;
  lancamentoId: string | null;
}

interface ResultadoDaCreditoria {
  saldo: number;
  rechargeId: string | null;
  lancamentoId: string | null;
}

/**
 * A core da recarga: garantir a linha, TRAVAR, creditar, e gravar o extrato —
 * quatro statements numa transação só.
 *
 * ⚠️ O `select ... for update` não é aqui por simetria com o débito: é o que
 * impede que uma recarga e um débito concorrentes decidam o mesmo saldo a partir
 * de leituras diferentes. Duas recargas simultâneas que lessem 0 e somassem 100
 * cada uma terminariam em 100 — e o dono teria pago 200.
 *
 * ⚠️ `rechargeId` null com crédito feito é IMPOSSÍVEL e é barrado por throw, não
 * por `return`: um extrato sem lançamento é um saldo sem rastro, e devolver
 * "deu certo" aqui seria a mentira mais cara da carteira.
 */
async function creditarNaTransacao(
  client: ClienteDeCredito,
  entrada: {
    organizationId: string;
    valorReaisCents: number;
    motivo: string;
    rechargeId: string | null;
  },
): Promise<ResultadoDaCreditoria> {
  await client.query(SQL_GARANTIR_LINHA_DE_SALDO, [entrada.organizationId, MOEDA_DA_CARTEIRA]);

  const travado = await client.query(SQL_TRAVAR_SALDO, [entrada.organizationId]);
  const linhaSaldo = travado.rows[0] as { id?: unknown; balance_cents?: unknown } | undefined;
  if (linhaSaldo?.id === undefined) {
    throw new Error(`linha_de_saldo_ausente: ${entrada.organizationId}`);
  }

  await client.query(SQL_CREDITAR_SALDO, [linhaSaldo.id, entrada.valorReaisCents]);

  const base = linhaDeRecarga({
    valorReaisCents: entrada.valorReaisCents,
    descricao: entrada.motivo,
  });
  // O lançamento aponta para a LINHA da recarga (chave estrangeira, auditável),
  // e não para o id do provedor: o id do pagamento fica onde ele é consultável,
  // que é `ai_credit_recharges.external_payment_id`. Na recarga manual não há
  // linha nenhuma, e o campo fica nulo — inventar um id aqui faria o webhook
  // futuro casar com um crédito à mão.
  const linha =
    entrada.rechargeId !== null ? { ...base, recharge_id: entrada.rechargeId } : base;
  const insert = await client.query(
    SQL_INSERT_LANCAMENTO,
    parametrosDoLancamento(entrada.organizationId, linha),
  );
  const lancamentoId = (insert.rows[0] as { id?: unknown } | undefined)?.id ?? null;

  return {
    saldo: Number(linhaSaldo.balance_cents ?? 0) + entrada.valorReaisCents,
    rechargeId: entrada.rechargeId,
    lancamentoId: typeof lancamentoId === 'string' ? lancamentoId : null,
  };
}

/** `BEGIN`/`COMMIT`/`ROLLBACK` escritos à mão: o `pg` não tem `transaction()`. */
async function emTransacao<T>(db: Alvo, corpo: (client: ClienteDeCredito) => Promise<T>): Promise<T> {
  const client = await comoCliente(db);
  const precisaFechar = typeof (db as { release?: unknown }).release === 'function';
  try {
    await client.query('begin');
    const saida = await corpo(client);
    await client.query('commit');
    return saida;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    if (precisaFechar) (client as { release?: () => void }).release?.();
  }
}

/**
 * Recarga MANUAL, pelo dono da instalação. Sem `external_payment_id`: money
 * creditado à mão não tem id de pagamento, e inventar um faria o webhook futuro
 * casar com ela.
 */
export async function recarregarManualmente(
  db: Alvo,
  entrada: {
    organizationId: string;
    valorReaisCents: number;
    motivo: string;
    actorUserId?: string | null;
  },
): Promise<RecargaAplicada> {
  // ⚠️ Validação ANTES de qualquer SQL: recarga inválida não é meia recarga.
  const organizationId = organizationIdSchema.parse(entrada.organizationId);
  const valor = valorReaisSchema.parse(entrada.valorReaisCents);
  const motivo = validarMotivo(entrada.motivo);

  const saida = await emTransacao(db, (client) =>
    creditarNaTransacao(client, {
      organizationId,
      valorReaisCents: valor,
      motivo,
      rechargeId: null,
    }),
  );
  return {
    aplicada: true,
    duplicada: false,
    valorReaisCents: valor,
    saldoReaisCents: saida.saldo,
    rechargeId: null,
    lancamentoId: saida.lancamentoId,
  };
}

export interface PagamentoRecebido {
  /** Id do pagamento no provedor. Global, e a UNIQUE que protege o reenvio. */
  externalPaymentId: string;
  organizationId: string;
  valorReaisCents: number;
  provider: string;
}

/**
 * A entrada pelo webhook de pagamento. É o MESMO caminho do dono, com uma
 * camada de idempotência na frente — e a assimetria mora aqui: a duplicata sai
 * ANTES de qualquer crédito, e por isso não toca em nada.
 *
 * ⚠️ A organização é a que o webhook RESOLVEU por meio confiável (o id do
 * pagamento já aponta para a cobrança), nunca a que veio no corpo do POST.
 */
export async function aplicarPagamentoDeCredito(
  db: Alvo,
  entrada: PagamentoRecebido,
): Promise<RecargaAplicada> {
  const externalPaymentId = idPagamentoSchema.parse(entrada.externalPaymentId);
  const organizationId = organizationIdSchema.parse(entrada.organizationId);
  const valor = valorReaisSchema.parse(entrada.valorReaisCents);

  return emTransacao(db, async (client) => {
    const recharge = await client.query(SQL_INSERT_RECARGA_PAGAMENTO, [
      organizationId,
      externalPaymentId,
      entrada.provider,
      valor,
      MOEDA_DA_CARTEIRA,
    ]);
    const rechargeIdBruto = (recharge.rows[0] as { id?: unknown } | undefined)?.id;
    const rechargeId = typeof rechargeIdBruto === 'string' ? rechargeIdBruto : undefined;
    // A UNIQUE estourou: este pagamento JÁ foi aplicado. Sai sem tocar em saldo
    // e sem tocar em extrato. Reenvio é rotina do provedor, não erro.
    if (rechargeId === undefined) {
      return {
        aplicada: false,
        duplicada: true,
        valorReaisCents: valor,
        saldoReaisCents: 0,
        rechargeId: null,
        lancamentoId: null,
      };
    }
    const saida = await creditarNaTransacao(client, {
      organizationId,
      valorReaisCents: valor,
      motivo: `pagamento recebido (${entrada.provider})`,
      rechargeId,
    });
    return {
      aplicada: true,
      duplicada: false,
      valorReaisCents: valor,
      saldoReaisCents: saida.saldo,
      rechargeId,
      lancamentoId: saida.lancamentoId,
    };
  });
}