import { startTracing } from './observability/tracing';
const tracing = startTracing('gym-sms-api'); // before express/pg/ioredis are loaded

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { QueueControl } from './admin/routes';
import { createApp } from './app';
import { config, readSecret } from './config';
import { migrate } from './db/migrate';
import { createPool } from './db/pool';
import { smsQueueName } from './delivery/types';
import { RedisStatusFanout, RedisStatusSubscriber } from './live/redis-publisher';
import { SseHub } from './live/sse-hub';
import { logger } from './observability/logger';
import { seed } from './seed/seed';
import { parseSigningKeys, SigningKey } from './webhooks/signature-verifier';

const log = logger.child({ service: 'api' });

function loadSigningKeys(): SigningKey[] {
  return parseSigningKeys(readSecret('WEBHOOK_SIGNING_SECRETS'));
}

/** Startup order: (migrate), (demo seed), then listen. Safe to repeat. */
async function main() {
  let signingKeys = loadSigningKeys();
  // Twilio: primary auth token first, secondary during rotation (TWILIO_AUTH_TOKENS(_FILE)).
  let twilioTokens = parseSigningKeys(readSecret('TWILIO_AUTH_TOKENS'));
  if (config.production && signingKeys.length === 0 && !config.webhookSignaturesDisabled) {
    throw new Error('WEBHOOK_SIGNING_SECRETS(_FILE) is required in production (or set WEBHOOK_SIGNATURES=disabled for a local demo)');
  }
  if (signingKeys.length === 0) log.warn('webhook.signatures_disabled', {});

  const pool = createPool(config.databaseUrl);
  if (config.runMigrations) {
    const ran = await migrate(pool);
    if (ran.length) log.info('migrations.applied', { ran });
  }
  if (config.seedDemoData) {
    const seeded = await seed(pool);
    log.info('seed.ready', { ...seeded });
  }

  const hub = new SseHub();
  let redis: IORedis | undefined;
  let subscriber: RedisStatusSubscriber | undefined;
  let queueControl: QueueControl | undefined;
  let queue: Queue | undefined;
  if (config.redisUrl) {
    // Dedicated connections: commands, and a subscriber (which can't issue commands).
    redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
    subscriber = new RedisStatusSubscriber(new IORedis(config.redisUrl), hub);
    await subscriber.start();
    queue = new Queue(smsQueueName(config.smsProviderAccount), { connection: redis });
    const q = queue;
    queueControl = {
      pause: () => q.pause(),
      resume: () => q.resume(),
      counts: async () => ({ ...(await q.getJobCounts()), paused: Number(await q.isPaused()) }),
    };
  }

  const app = createApp({
    pool,
    hub,
    // Multi-instance: every replica publishes to Redis and every replica's hub listens to Redis.
    fanout: redis ? new RedisStatusFanout(redis) : hub,
    statusDrain: redis ? 'background' : 'await',
    webhook: {
      signingKeys: () => signingKeys,
      toleranceSec: config.webhookToleranceSec,
      rateLimit: config.webhookRateLimit,
    },
    twilio:
      twilioTokens.length && process.env.TWILIO_WEBHOOK_PUBLIC_BASE_URL
        ? { authTokens: () => twilioTokens, publicBaseUrl: process.env.TWILIO_WEBHOOK_PUBLIC_BASE_URL.replace(/\/$/, '') }
        : undefined,
    readinessChecks: redis ? [{ name: 'redis', check: () => redis!.ping() }] : [],
    adminToken: readSecret('ADMIN_API_TOKEN'),
    queueControl,
  });

  // Safety net for status changes committed by workers/dispatchers or left by a failed drain.
  const drainTimer = setInterval(() => void app.statusRelay.drain().catch(() => undefined), 1000);

  // Secret rotation without restart: update the mounted secret, then send SIGHUP.
  process.on('SIGHUP', () => {
    signingKeys = loadSigningKeys();
    twilioTokens = parseSigningKeys(readSecret('TWILIO_AUTH_TOKENS'));
    log.info('webhook.signing_keys_reloaded', { keys: signingKeys.map((k) => k.id), twilio: twilioTokens.map((k) => k.id) });
  });

  const server = app.listen(config.port, config.host, () => {
    log.info('api.listening', { host: config.host, port: config.port, redis: Boolean(redis) });
  });

  const shutdown = (signal: string) => {
    log.info('api.stopping', { signal });
    clearInterval(drainTimer);
    hub.close();
    server.close(() => {
      Promise.allSettled([subscriber?.stop(), queue?.close(), redis?.quit(), pool.end(), tracing?.shutdown()]).finally(() =>
        process.exit(0),
      );
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('api.start_failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
