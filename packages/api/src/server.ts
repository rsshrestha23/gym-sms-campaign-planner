import { createApp } from './app';
import { config } from './config';
import { migrate } from './db/migrate';
import { createPool } from './db/pool';
import { SseHub } from './live/sse-hub';
import { seed } from './seed/seed';

/** Startup order: migrate, idempotent seed, then listen. Safe to repeat. */
async function main() {
  const pool = createPool(config.databaseUrl);
  const ran = await migrate(pool);
  if (ran.length) console.log(`Applied migrations: ${ran.join(', ')}`);
  const seeded = await seed(pool);
  console.log(`Seed ready: ${seeded.branches} branches, ${seeded.members} members, campaign ${seeded.campaignId}`);

  const hub = new SseHub();
  const app = createApp({ pool, hub });
  const server = app.listen(config.port, config.host, () => {
    console.log(`API listening on http://${config.host}:${config.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    hub.close();
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('API failed to start', err);
  process.exit(1);
});
