import { afterEach, describe, expect, it, vi } from 'vitest';

import { poolOptions } from './pool';

afterEach(() => vi.unstubAllEnvs());

describe('pool Postgres da aplicação', () => {
  it('preserva o default do pg quando o teto não foi configurado', () => {
    vi.stubEnv('DB_POOL_MAX', '');
    vi.stubEnv('SUPABASE_DB_SSL_CA', '');
    expect(poolOptions('postgresql://db.example/postgres')).toEqual({
      connectionString: 'postgresql://db.example/postgres',
    });
  });

  it('usa CA fornecida e exige validação do certificado', () => {
    vi.stubEnv('SUPABASE_DB_SSL_CA', '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----');
    vi.stubEnv('DB_POOL_MAX', '2');
    expect(poolOptions('postgresql://db.example/postgres')).toEqual({
      connectionString: 'postgresql://db.example/postgres',
      max: 2,
      ssl: { ca: '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----', rejectUnauthorized: true },
    });
  });

  it('aceita o teto configurado somente quando é inteiro positivo', () => {
    vi.stubEnv('SUPABASE_DB_SSL_CA', '');
    vi.stubEnv('DB_POOL_MAX', '5');
    expect(poolOptions('postgresql://db.example/postgres').max).toBe(5);
    vi.stubEnv('DB_POOL_MAX', '-1');
    expect(poolOptions('postgresql://db.example/postgres').max).toBeUndefined();
  });

  it('configura role service_role na aquisição e falha fechado se SET ROLE falhar', async () => {
    vi.stubEnv('SUPABASE_DB_ROLE', 'service_role');
    const options = poolOptions('postgresql://db.example/postgres');
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const verify = options.verify!;
    const client = { query } as never;
    const success = vi.fn();
    verify(client, success);
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith());
    expect(query).toHaveBeenCalledWith('SET ROLE service_role');

    query.mockRejectedValueOnce(new Error('permission denied'));
    const failure = vi.fn();
    verify(client, failure);
    await vi.waitFor(() => expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'permission denied' })));
  });

  it('recusa qualquer valor de role fora da allowlist literal', () => {
    vi.stubEnv('SUPABASE_DB_ROLE', 'service_role; select 1');
    expect(() => poolOptions('postgresql://db.example/postgres')).toThrow('somente service_role');
  });
});
