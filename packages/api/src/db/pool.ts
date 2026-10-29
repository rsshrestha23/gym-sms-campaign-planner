import { Pool, PoolClient, types } from 'pg';

// Return COUNT(*) and other int8 values as numbers; every count in this app fits safely.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));
// Keep DATE columns as 'YYYY-MM-DD' strings instead of shifting them through the host time zone.
types.setTypeParser(types.builtins.DATE, (value) => value);

export type Db = Pool;

export function createPool(connectionString: string, max = 20): Pool {
  return new Pool({ connectionString, max });
}

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
