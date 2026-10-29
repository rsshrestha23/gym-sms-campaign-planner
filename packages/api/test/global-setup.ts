import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/db/migrate';
import { createPool } from '../src/db/pool';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('gym_test')
    .withUsername('gym')
    .withPassword('gym')
    .start();
  const databaseUrl = container.getConnectionUri();
  const pool = createPool(databaseUrl, 1);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  project.provide('databaseUrl', databaseUrl);
}

export async function teardown() {
  await container?.stop();
}
