/**
 * Dispatch/worker throughput and fault test.
 *
 *   npm run load:dispatch -- [--branches 2000] [--slots 5] [--workers 4] [--concurrency 25] [--rate 400]
 *
 * Builds a synthetic live campaign in its own database (`gym_dispatch_load`): `branches` branches
 * in a time zone whose window is open now, each with `slots` due sends at the last two-minute
 * slots (inside the 10-minute grace) plus one future send that must NOT go out. Then runs the real
 * dispatcher, outbox relay, BullMQ (compose Redis), and workers in-process against a provider
 * that injects latency, 503s, 429s, and accepted-then-timeout responses, force-kills one worker
 * mid-run, and verifies delivery invariants. Prints a JSON report.
 */
import os from 'node:os';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { ClaimService } from '../../../api/src/delivery/claim-service';
import { isWithinSendWindow } from '../../../api/src/delivery/send-window';
import { migrate } from '../../../api/src/db/migrate';
import { createPool } from '../../../api/src/db/pool';
import { OutboxRepository } from '../../../api/src/outbox/outbox-repository';
import { OutboxRelay } from '../../../api/src/outbox/relay';
import { dispatchDueBatch } from '../../../dispatcher/src/due-send-loop';
import { ProviderError, SendSmsInput } from '../../src/providers/provider';
import { SimulatedBehaviour, SimulatedProvider } from '../../src/providers/simulated-provider';
import { defaultJobOptions } from '../../src/queues/sms-send';
import { createSmsWorker } from '../../src/worker';

process.env.LOG_LEVEL ??= 'silent';
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const BRANCHES = arg('branches', 2000);
const SLOTS = arg('slots', 5);
const WORKERS = arg('workers', 4);
const CONCURRENCY = arg('concurrency', 25);
const RATE = arg('rate', 400);
const ZONES = ['Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney', 'Asia/Kathmandu'];

/** Provider with realistic latency and injected faults; honours idempotency keys. */
class FaultyProvider extends SimulatedProvider {
  calls = 0;
  async send(input: SendSmsInput) {
    this.calls++;
    const r = Math.random();
    const latency = 20 + Math.floor(Math.random() * 60);
    let b: SimulatedBehaviour = { type: 'accept' };
    if (r < 0.08) b = { type: 'error', error: new ProviderError('retryable', '503', 'unavailable') };
    else if (r < 0.09) b = { type: 'error', error: new ProviderError('rate_limited', '429', 'slow down', 300) };
    else if (r < 0.10) b = { type: 'accept_then_timeout' };
    this.enqueue({ type: 'delay', ms: latency, then: b });
    return super.send(input);
  }
}

const pct = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);

async function main() {
  const zone = ZONES.find((z) => isWithinSendWindow(new Date(), z) && isWithinSendWindow(new Date(Date.now() - 12 * 60_000), z));
  if (!zone) throw new Error('No candidate zone has an open sending window right now');
  const baseUrl = process.env.LOAD_DATABASE_URL ?? 'postgres://gym:gym@localhost:5433/gym';
  const admin = createPool(baseUrl, 1);
  await admin.query('DROP DATABASE IF EXISTS gym_dispatch_load');
  await admin.query('CREATE DATABASE gym_dispatch_load');
  await admin.end();
  const url = new URL(baseUrl);
  url.pathname = '/gym_dispatch_load';
  const pool = createPool(url.toString(), 60);
  const redisUrl = process.env.LOAD_REDIS_URL ?? 'redis://localhost:6380';
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queueName = `sms-send.load-${Date.now()}`;
  // Production retry policy (8 attempts, exponential backoff + jitter).
  const queue = new Queue(queueName, { connection: redis, defaultJobOptions });
  const info = async (key: string) => Number((await redis.info('memory')).match(new RegExp(`^${key}:(\\d+)`, 'm'))?.[1] ?? 0);
  const report: Record<string, unknown> = { zone, branches: BRANCHES, slotsPerBranch: SLOTS, workers: WORKERS, concurrency: CONCURRENCY, providerRateLimit: RATE };

  try {
    await migrate(pool);
    // Synthetic live plan: due slots on the 2-minute grid inside the grace, plus one future slot.
    const now = Date.now();
    const lastSlot = Math.floor(now / 120_000) * 120_000;
    await pool.query(`INSERT INTO branches (id, name, time_zone) SELECT b, 'Load ' || b, $1 FROM generate_series(1, $2::int) b`, [zone, BRANCHES]);
    await pool.query(`INSERT INTO campaigns (id, name, start_date, end_date, dispatch_enabled) VALUES (1, 'Dispatch load', current_date - 1, current_date + 1, true)`);
    await pool.query(`INSERT INTO campaign_branches SELECT 1, id FROM branches`);
    const perBranch = SLOTS + 1;
    await pool.query(
      `INSERT INTO members (id, branch_id, name, phone)
       SELECT m, 1 + (m - 1) / $1::int, 'Load Member ' || m, '+1888' || lpad(m::text, 9, '0') FROM generate_series(1, $1::int * $2::int) m`,
      [perBranch, BRANCHES],
    );
    await pool.query(
      `INSERT INTO sends (campaign_id, branch_id, member_id, status, scheduled_at, dispatch_state)
       SELECT 1, m.branch_id, m.id, 'planned',
              to_timestamp(($1::bigint - 120000 * ((m.id - 1) % $2::int - 1)) / 1000.0),  -- k=0 is the future slot
              'waiting'
         FROM members m`,
      [lastSlot, perBranch],
    );
    // Every send becomes due within two minutes: the future slot must go out at its slot, not before.
    const due = Number((await pool.query(`SELECT count(*) AS n FROM sends`)).rows[0].n);
    const future = Number((await pool.query(`SELECT count(*) AS n FROM sends WHERE scheduled_at > now()`)).rows[0].n);
    report.sends = due;
    report.notYetDueAtStart = future;

    const provider = new FaultyProvider();
    const claims = new ClaimService(pool, { workerId: `${os.hostname()}-load`, leaseMs: 5_000, idempotencyWindowMs: 3600_000 });
    const workerConnections = Array.from({ length: WORKERS }, () => redis.duplicate());
    const workers = workerConnections.map((connection) =>
      createSmsWorker({
        connection, queueName, claims, provider, concurrency: CONCURRENCY, maxAttempts: 8,
        limiter: { max: RATE, duration: 1000 }, lockDuration: 5_000, stalledInterval: 5_000,
      }),
    );
    workers.forEach((w) => void w.run());
    const relay = new OutboxRelay(new OutboxRepository(pool), queue as never, { batchSize: 500 });
    const redisBefore = await info('used_memory');

    const started = Date.now();
    let stop = false;
    let peakQueue = 0;
    const loops = [
      (async () => { while (!stop) { const r = await dispatchDueBatch(pool, { batchSize: 1000 }); if (r.examined === 0) await new Promise((x) => setTimeout(x, 200)); } })(),
      (async () => { while (!stop) { if ((await relay.drain()) === 0) await new Promise((x) => setTimeout(x, 100)); } })(),
      (async () => { while (!stop) { const c = await queue.getJobCounts('waiting', 'delayed'); peakQueue = Math.max(peakQueue, c.waiting + c.delayed); await new Promise((x) => setTimeout(x, 250)); } })(),
    ];
    // Fault: force-kill one worker a third of the way in (no graceful close): its active jobs
    // stall, their claims expire, and BullMQ hands them to the surviving workers.
    let killedActive = 0;
    const killer = (async () => {
      while (provider.calls < due / 3) await new Promise((x) => setTimeout(x, 50));
      killedActive = await queue.getActiveCount();
      await workers[0].close(true);
    })();

    const terminal = async () =>
      Number((await pool.query(`SELECT count(*) AS n FROM sends WHERE status <> 'planned' OR dispatch_state = 'dead_letter'`)).rows[0].n);
    const deadline = Date.now() + 15 * 60_000;
    let done = 0;
    while ((done = await terminal()) < due && Date.now() < deadline) await new Promise((x) => setTimeout(x, 500));
    const elapsed = (Date.now() - started) / 1000;
    stop = true;
    await Promise.all([...loops, killer]);
    await Promise.all(workers.slice(1).map((w) => w.close()));
    // Workers don't own the connections they were given; close them or the process never exits.
    workerConnections.forEach((c) => c.disconnect());
    const redisAfter = await info('used_memory');

    const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
    const [states] = await q(`SELECT
        count(*) FILTER (WHERE status = 'sent')::int AS sent,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'not_scheduled')::int AS missed,
        count(*) FILTER (WHERE dispatch_state = 'dead_letter')::int AS dead_letter,
        count(*) FILTER (WHERE status = 'planned' AND dispatch_state = 'dead_letter')::int AS parked_ambiguous
      FROM sends`);
    // Lag is only meaningful for slots that arrived during the run; earlier slots were a
    // deliberate backlog at start (reported as drain time instead).
    const lags = (await q(
      `SELECT EXTRACT(EPOCH FROM a.started_at - s.scheduled_at)::float AS lag FROM send_attempts a JOIN sends s ON s.id = a.send_id
        WHERE a.attempt_number = 1 AND s.scheduled_at > $1 ORDER BY 1`,
      [new Date(started)],
    )).map((r) => r.lag as number);
    const [drain] = await q(
      `SELECT EXTRACT(EPOCH FROM max(a.finished_at) - $1::timestamptz)::float AS seconds, count(DISTINCT s.id)::int AS n
         FROM sends s JOIN send_attempts a ON a.send_id = s.id AND a.outcome = 'accepted' WHERE s.scheduled_at <= $1`,
      [new Date(started)],
    );
    const [early] = await q(`SELECT count(*)::int AS n FROM send_attempts a JOIN sends s ON s.id = a.send_id WHERE a.started_at < s.scheduled_at`);
    const [outcomes] = await q(`SELECT jsonb_object_agg(outcome, n) AS o FROM (SELECT outcome, count(*)::int AS n FROM send_attempts GROUP BY 1) x`);
    const acceptedKeys = provider.acceptanceCount;
    const sentWithMessage = Number((await q(`SELECT count(*)::int AS n FROM sends WHERE provider_message_id IS NOT NULL`))[0].n);

    report.result = {
      seconds: +elapsed.toFixed(1),
      terminalOfDue: `${done}/${due}`,
      ...states,
      providerCalls: provider.calls,
      providerAcceptances: acceptedKeys,
      sendsWithProviderMessageId: sentWithMessage,
      attemptsByOutcome: outcomes.o,
      activeJobsWhenWorkerKilled: killedActive,
      sentBeforeSlot: early.n,
      backlogAtStart: drain.n,
      backlogDrainSeconds: +drain.seconds.toFixed(1),
      backlogSendsPerSecond: Math.round(drain.n / drain.seconds),
      onTimeFirstAttemptLagSeconds: { p50: +pct(lags, 50).toFixed(2), p95: +pct(lags, 95).toFixed(2), max: +(lags[lags.length - 1] ?? 0).toFixed(2) },
      peakQueuedJobs: peakQueue,
      redisUsedMemoryMB: { before: +(redisBefore / 2 ** 20).toFixed(1), after: +(redisAfter / 2 ** 20).toFixed(1) },
    };
    // Exactly-once acceptance per send: every accepted idempotency key maps to exactly one send.
    report.invariants = {
      noAttemptBeforeItsSlot: early.n === 0,
      oneAcceptancePerSentSend: acceptedKeys === sentWithMessage,
      allDueSendsTerminal: done === due,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await redis.quit();
    await pool.end();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
