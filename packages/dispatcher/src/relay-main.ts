import { startTracing } from '../../api/src/observability/tracing';
const tracing = startTracing('gym-sms-outbox-relay');

import http from 'node:http';
import IORedis from 'ioredis';
import { Client } from 'pg';
import { config } from '../../api/src/config';
import { createPool } from '../../api/src/db/pool';
import { RedisStatusFanout } from '../../api/src/live/redis-publisher';
import { logger } from '../../api/src/observability/logger';
import { outboxAge, registry } from '../../api/src/observability/metrics';
import { OutboxRepository } from '../../api/src/outbox/outbox-repository';
import { OutboxRelay } from '../../api/src/outbox/relay';
import { StatusEventRelay } from '../../api/src/webhooks/event-outbox';
import { createSmsQueue } from '../../workers/src/queues/sms-send';

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const log = logger.child({ service: 'outbox-relay' });

/**
 * Outbox relay: send_outbox -> BullMQ jobs, and status_event_outbox -> Redis Pub/Sub. Both use
 * leases, so replicas can run side by side. Status rows are drained on LISTEN/NOTIFY wake-ups
 * (low latency) with a periodic sweep as the fallback.
 */
async function main() {
  const pool = createPool(config.databaseUrl, num('DB_POOL_SIZE', 5));
  const redis = new IORedis(config.redisUrl ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  const queue = createSmsQueue(redis, config.smsProviderAccount);
  const outbox = new OutboxRepository(pool);
  const dispatchRelay = new OutboxRelay(outbox, queue, {
    batchSize: num('RELAY_BATCH_SIZE', 200),
    onError: (err, row) => log.warn('relay.enqueue_failed', { outboxId: row.id, error: (err as Error).message }),
  });
  const statusRelay = new StatusEventRelay(pool, new RedisStatusFanout(redis));
  let stopping = false;

  const listener = new Client({ connectionString: config.databaseUrl });
  await listener.connect();
  listener.on('notification', () => void statusRelay.drain().catch(() => undefined));
  listener.on('error', (err) => log.error('relay.listen_failed', { error: err.message }));
  await listener.query('LISTEN status_event_outbox');

  const loop = (name: string, everyMs: number, fn: () => Promise<unknown>) => {
    const tick = async () => {
      if (stopping) return;
      await fn().catch((err) => log.error(`${name}.failed`, { error: (err as Error).message }));
      if (!stopping) setTimeout(tick, everyMs);
    };
    void tick();
  };
  loop('dispatch_relay', num('RELAY_INTERVAL_MS', 250), () => dispatchRelay.drain());
  loop('status_relay', 1000, () => statusRelay.drain());
  loop('outbox_age', 5000, async () => {
    outboxAge.set({ outbox: 'dispatch' }, await outbox.oldestPendingAgeSeconds());
    const { rows } = await pool.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float AS age FROM status_event_outbox WHERE published_at IS NULL`,
    );
    outboxAge.set({ outbox: 'status' }, rows[0].age);
  });

  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('content-type', registry.contentType);
      return res.end(await registry.metrics());
    }
    if (req.url === '/health/live') return res.end('ok');
    if (req.url === '/health/ready') {
      const ok = await Promise.all([pool.query('SELECT 1'), redis.ping()]).then(() => true, () => false);
      res.statusCode = ok ? 200 : 503;
      return res.end(ok ? 'ready' : 'not ready');
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(num('METRICS_PORT', 9466));
  log.info('relay.started', {});

  const shutdown = async (signal: string) => {
    stopping = true;
    log.info('relay.stopping', { signal });
    server.close();
    await Promise.allSettled([listener.end(), queue.close(), redis.quit(), pool.end(), tracing?.shutdown()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('outbox relay failed to start', err);
  process.exit(1);
});
