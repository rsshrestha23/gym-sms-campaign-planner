import http from 'node:http';
import os from 'node:os';
import { config } from '../../api/src/config';
import { ClaimService } from '../../api/src/delivery/claim-service';
import { createPool } from '../../api/src/db/pool';
import { logger } from '../../api/src/observability/logger';
import { startTracing } from '../../api/src/observability/tracing';
import { registry } from './observability/metrics';
import { selectProvider } from './providers/selected-provider';
import { createRedisConnection, createSmsQueue, DEFAULT_MAX_ATTEMPTS, smsQueueName } from './queues/sms-send';
import { createSmsWorker, sampleQueueMetrics } from './worker';

const env = process.env;
const num = (name: string, fallback: number) => Number(env[name] ?? fallback);

async function main() {
  const tracing = startTracing('gym-sms-worker');
  const log = logger.child({ service: 'worker' });
  // config reads NAME or NAME_FILE (secret-manager mounts).
  const pool = createPool(config.databaseUrl, num('DB_POOL_SIZE', 20));
  const redis = createRedisConnection(config.redisUrl ?? 'redis://localhost:6379');
  const account = config.smsProviderAccount;
  const queue = createSmsQueue(redis, account);
  const workerId = `${os.hostname()}:${process.pid}`;

  const claims = new ClaimService(pool, {
    workerId,
    leaseMs: num('CLAIM_LEASE_MS', 60_000),
    missedSlotGraceMs: num('MISSED_SLOT_GRACE_MS', 10 * 60_000),
    idempotencyWindowMs: num('PROVIDER_IDEMPOTENCY_WINDOW_MS', 24 * 3600_000),
  });
  const worker = createSmsWorker({
    connection: redis,
    queueName: smsQueueName(account),
    claims,
    provider: selectProvider(env),
    concurrency: num('WORKER_CONCURRENCY', 20),
    limiter: { max: num('PROVIDER_RATE_LIMIT_PER_SECOND', 50), duration: 1000 },
    maxAttempts: num('SEND_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
    log: (event, fields) => log.info(event, fields),
  });

  let ready = false;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      await sampleQueueMetrics(queue, redis).catch(() => undefined);
      res.setHeader('content-type', registry.contentType);
      return res.end(await registry.metrics());
    }
    if (req.url === '/health/live') return res.end('ok'); // never depends on the provider
    if (req.url === '/health/ready') {
      const ok = ready && (await Promise.all([pool.query('SELECT 1'), redis.ping()]).then(() => true, () => false));
      res.statusCode = ok ? 200 : 503;
      return res.end(ok ? 'ready' : 'not ready');
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(num('METRICS_PORT', 9464));

  void worker.run();
  ready = true;
  log.info('worker.started', { workerId, queue: smsQueueName(account) });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    ready = false;
    log.info('worker.stopping', { signal });
    // Stops taking new jobs and waits for in-flight provider calls to finish and be recorded.
    await worker.close();
    await queue.close();
    server.close();
    await Promise.allSettled([redis.quit(), pool.end(), tracing?.shutdown()]);
    log.info('worker.stopped', {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('worker failed to start', err);
  process.exit(1);
});
