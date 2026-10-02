/**
 * Pool do Postgres do harness (SQL cru tipado, sem ORM — stack.md §1/§3).
 * A URL vem do env (SUPABASE_DB_URL), nunca hardcoded.
 *
 * Backend morrendo (blip/restart do Postgres) emite 'error' sem handler e
 * derruba o processo — pitfall canônico do pg, em DUAS formas:
 *   1. cliente OCIOSO no pool → o Pool re-emite 'error' (doc do pg-pool);
 *   2. cliente EM CHECKOUT sem query ativa (ex.: entre BEGIN e a próxima query
 *      de uma transação) → o 'error' sai no próprio Client, que fica SEM
 *      listener (pg-pool remove o idleListener no acquire).
 * Por isso o seam anexa um listener POR CLIENTE (evento 'connect', 1x por
 * conexão nova, sobrevive a checkout/release) — ele cobre as duas formas e
 * loga estruturado; o pool se recupera sozinho criando conexões novas.
 * `onError` injetável mantém o log no logger do consumidor (main.ts passa o
 * seu); o default usa o logger estruturado de obs/ para que NENHUM consumidor
 * do seam (testes, scripts) fique exposto ao crash.
 */
import pg from 'pg';

import { createLogger } from '../obs/logger';

export function poolOptions(databaseUrl: string): pg.PoolConfig {
  const raw = process.env.DB_POOL_MAX;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const max = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  const ca = process.env.SUPABASE_DB_SSL_CA;
  const role = process.env.SUPABASE_DB_ROLE;
  if (role && role !== 'service_role') {
    throw new Error('SUPABASE_DB_ROLE aceita somente service_role');
  }
  return {
    connectionString: databaseUrl,
    ...(max !== undefined ? { max } : {}),
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    ...(role === 'service_role'
      ? {
          verify: (client: pg.PoolClient, done: (err?: Error) => void) => {
            client.query('SET ROLE service_role')
              .then(() => done())
              .catch((err: unknown) => done(err instanceof Error ? err : new Error(String(err))));
          },
        }
      : {}),
  };
}

export function createPool(
  databaseUrl: string,
  onError?: (err: Error) => void,
): pg.Pool {
  // DB_POOL_MAX permite limitar conexões por instância serverless. Sem knob,
  // preservamos o default 10 do pg para compatibilidade com self-host.
  const pool = new pg.Pool(poolOptions(databaseUrl));
  const handler =
    onError ??
    ((err: Error): void => {
      // mesma disciplina de errMsg do main.ts: 1ª linha truncada, PII fora
      const error = (err.message.split('\n', 1)[0] ?? '').slice(0, 300);
      createLogger().error('pool: conexão caiu — recria no próximo uso', { error });
    });
  pool.on('connect', (client) => client.on('error', handler));
  // Guarda contra crash na re-emissão do Pool (forma 1). NÃO loga: o mesmo erro
  // já passou pelo listener por-cliente acima (o pg-pool só re-emite 'error' de
  // cliente ocioso, e o 'error' do Client dispara os dois listeners em ordem).
  pool.on('error', () => undefined);
  return pool;
}
