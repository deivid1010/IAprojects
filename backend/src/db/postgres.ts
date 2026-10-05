import pg from 'pg';

export type PgPool = pg.Pool;

export function createPgPool(connectionString: string): PgPool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function pingPostgres(pool: PgPool): Promise<void> {
  await pool.query('SELECT 1');
}
