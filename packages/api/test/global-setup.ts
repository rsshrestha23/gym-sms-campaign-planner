import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/db/migrate';
import { createPool } from '../src/db/pool';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

/** One isolated PostgreSQL and one Redis for the whole server test run. */
export async function setup(project: TestProject) {
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').withDatabase('gym_test').withUsername('gym').withPassword('gym').start(),
    // BullMQ requires noeviction; match production.
    new RedisContainer('redis:7-alpine').withCommand(['redis-server', '--maxmemory-policy', 'noeviction']).start(),
  ]);
  const databaseUrl = postgres.getConnectionUri();
  const pool = createPool(databaseUrl, 1);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redis.getConnectionUrl());
}

export async function teardown() {
  await Promise.all([postgres?.stop(), redis?.stop()]);
}
