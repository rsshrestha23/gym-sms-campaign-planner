import { startTracing } from '../../api/src/observability/tracing';
const tracing = startTracing('gym-sms-dispatcher');

import http from 'node:http';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../../api/src/config';
import { createPool } from '../../api/src/db/pool';
import { smsQueueName } from '../../api/src/delivery/types';
import { reconcileAllStatusCounts } from '../../api/src/live/status-projection';
import { logger } from '../../api/src/observability/logger';
import { dispatchedSends, dueSendLag, reconciledDispatches, registry } from '../../api/src/observability/metrics';
import { runRetention } from './retention';
import { dispatchDueBatch, reconcileStuckDispatches } from './due-send-loop';

const env = process.env;
const num = (name: string, fallback: number) => Number(env[name] ?? fallback);
const log = logger.child({ service: 'dispatcher' });

/**
 * Due-send dispatcher: moves due sends to `queued` + outbox, repairs dispatches lost from Redis,
 * and runs periodic maintenance (count reconciliation, retention). Safe to run several replicas:
 * dispatch uses SKIP LOCKED, reconciliation and maintenance take advisory locks.
 */
async function main() {
  const pool = createPool(config.databaseUrl, num('DB_POOL_SIZE', 5));
  const redis = new IORedis(config.redisUrl ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  const queue = new Queue(smsQueueName(config.smsProviderAccount), { connection: redis });
  const batchSize = num('DISPATCH_BATCH_SIZE', 500);
  const graceMs = num('MISSED_SLOT_GRACE_MS', 10 * 60_000);
  const shard = env.DISPATCH_SHARD_COUNT
    ? { index: num('DISPATCH_SHARD_INDEX', 0), count: num('DISPATCH_SHARD_COUNT', 1) }
    : undefined;
  let stopping = false;
  let healthy = true;

  const loop = (name: string, everyMs: number, fn: () => Promise<void>) => {
    const tick = async () => {
      if (stopping) return;
      try {
        await fn();
        healthy = true;
      } catch (err) {
        healthy = false;
        log.error(`${name}.failed`, { error: (err as Error).message });
      }
      if (!stopping) setTimeout(tick, everyMs);
    };
    void tick();
  };

  loop('dispatch', num('DISPATCH_INTERVAL_MS', 1000), async () => {
    for (;;) {
      const r = await dispatchDueBatch(pool, { batchSize, missedSlotGraceMs: graceMs, shard });
      if (r.queued) dispatchedSends.inc({ result: 'queued' }, r.queued);
      if (r.missed) {
        dispatchedSends.inc({ result: 'missed' }, r.missed);
        log.warn('dispatch.missed_slots', { count: r.missed }); // alert: sends will not go out
      }
      if (r.examined < batchSize || stopping) break;
    }
    const { rows } = await pool.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(scheduled_at)), 0)::float AS lag
         FROM sends s JOIN campaigns c ON c.id = s.campaign_id
        WHERE s.status = 'planned' AND s.dispatch_state = 'waiting' AND s.scheduled_at <= now()
          AND c.dispatch_enabled AND c.paused_at IS NULL AND c.cancelled_at IS NULL`,
    );
    dueSendLag.set(rows[0].lag);
  });

  loop('reconcile', num('RECONCILE_INTERVAL_MS', 30_000), async () => {
    const { repaired } = await reconcileStuckDispatches(
      pool,
      { getJobState: async (id) => ((await queue.getJob(id)) ? queue.getJobState(id) : null) },
      { staleMs: num('RECONCILE_STALE_MS', 5 * 60_000) },
    );
    if (repaired.length) {
      reconciledDispatches.inc(repaired.length);
      log.warn('reconcile.repaired', { count: repaired.length });
    }
  });

  loop('status_counts', num('COUNT_RECONCILE_INTERVAL_MS', 15 * 60_000), async () => {
    const drift = await reconcileAllStatusCounts(pool);
    if (Object.keys(drift).length) log.warn('status_counts.drift_repaired', { drift });
  });

  loop('retention', num('RETENTION_INTERVAL_MS', 6 * 3600_000), async () => {
    const result = await runRetention(pool, {
      receiptRetentionDays: num('RECEIPT_RETENTION_DAYS', 90),
      attemptArchiveDays: num('ATTEMPT_ARCHIVE_DAYS', 400),
      dedupeRetentionDays: num('DEDUPE_RETENTION_DAYS', 400),
      providerRetryWindowDays: num('PROVIDER_RETRY_WINDOW_DAYS', 30),
    });
    if (result) log.info('retention.ran', result);
  });

  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('content-type', registry.contentType);
      return res.end(await registry.metrics());
    }
    if (req.url === '/health/live') return res.end('ok');
    if (req.url === '/health/ready') {
      const ok = healthy && (await Promise.all([pool.query('SELECT 1'), redis.ping()]).then(() => true, () => false));
      res.statusCode = ok ? 200 : 503;
      return res.end(ok ? 'ready' : 'not ready');
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(num('METRICS_PORT', 9465));
  log.info('dispatcher.started', { batchSize, graceMs, shard });

  const shutdown = async (signal: string) => {
    stopping = true;
    log.info('dispatcher.stopping', { signal });
    server.close();
    await Promise.allSettled([queue.close(), redis.quit(), pool.end(), tracing?.shutdown()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('dispatcher failed to start', err);
  process.exit(1);
});
