import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../config/env.js';
import { createPgPool, type PgPool } from './postgres.js';

// Runner de migraciones mínimo: archivos .sql numerados, aplicados en orden,
// cada uno en su propia transacción. Usamos SQL plano (sin ORM) porque las
// garantías críticas del sistema (UNIQUE, EXCLUDE, RLS) viven en el esquema y
// queremos verlas explícitas.
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(pool: PgPool, log: (msg: string) => void = console.log): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`migración aplicada: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`falló la migración ${file}: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

// Ejecución directa: `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = loadEnv();
  const pool = createPgPool(env.DATABASE_URL);
  runMigrations(pool)
    .then(() => console.log('migraciones al día'))
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
