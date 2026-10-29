import fs from 'node:fs';
import path from 'node:path';
import { Pool, PoolClient } from 'pg';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
// Arbitrary constant so concurrent API starts serialize their migration runs.
const MIGRATION_LOCK_KEY = 4_277_001;
/**
 * First-line marker for migrations that must run outside a transaction, e.g. CREATE INDEX
 * CONCURRENTLY on a large live table. Each statement runs on its own, so every statement in such a
 * file must be idempotent (IF NOT EXISTS) to make a retry after a partial failure safe.
 */
const NO_TRANSACTION_MARKER = '-- migrate:no-transaction';

export function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

async function applyFile(client: PoolClient, file: string): Promise<void> {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  if (sql.startsWith(NO_TRANSACTION_MARKER)) {
    for (const statement of splitStatements(sql)) await client.query(statement);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    return;
  }
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** `until` (inclusive file name) lets tests stop at an earlier schema to exercise upgrades. */
export async function migrate(pool: Pool, { until }: { until?: string } = {}): Promise<string[]> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && (until === undefined || f <= until))
    .sort();

  const client = await pool.connect();
  try {
    // Session-level lock: held across both transactional and non-transactional files.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      await applyFile(client, file);
      ran.push(file);
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
