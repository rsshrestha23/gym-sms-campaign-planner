import { Pool } from 'pg';
import { createPool } from '../src/db/pool';
import { resetDatabase, seed } from '../src/seed/seed';

export function testPool(max = 20): Pool {
  return createPool(process.env.DATABASE_URL!, max);
}

/** Empty all app tables and load the deterministic seed. */
export async function freshSeed(pool: Pool): Promise<void> {
  await resetDatabase(pool);
  await seed(pool);
}

export async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params);
  return Number(rows[0].n);
}
