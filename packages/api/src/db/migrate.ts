import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { withTransaction } from './pool';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
// Arbitrary constant so concurrent API starts serialize their migration runs.
const MIGRATION_LOCK_KEY = 4_277_001;

export async function migrate(pool: Pool): Promise<string[]> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
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
      await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      ran.push(file);
    }
    return ran;
  });
}
