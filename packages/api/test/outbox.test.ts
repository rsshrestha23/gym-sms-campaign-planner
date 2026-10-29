import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { dispatchDueBatch, reconcileStuckDispatches } from '../../dispatcher/src/due-send-loop';
import { CampaignRepository } from '../src/campaigns/repository';
import type { SendJobData } from '../src/delivery/types';
import { OutboxRepository } from '../src/outbox/outbox-repository';
import { JobQueue, OutboxRelay } from '../src/outbox/relay';
import { count, freshSeed, testPool } from './helpers';

const pool = testPool(30);
let redis: IORedis;
let queue: Queue<SendJobData>;
const QUEUE = 'sms-send.outbox-test';

// Inside every branch's window: London 09:05 BST, Kathmandu 13:50, Sydney 19:05 (Fri 23 Oct).
const AT = new Date('2026-10-23T08:05:00Z');
const NO_GRACE_LIMIT = Number.MAX_SAFE_INTEGER;

beforeAll(async () => {
  redis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  queue = new Queue<SendJobData>(QUEUE, { connection: redis });
});
afterAll(async () => {
  await queue.close();
  await redis.quit();
  await pool.end();
});
beforeEach(async () => {
  await queue.obliterate({ force: true });
  await freshSeed(pool);
  await new CampaignRepository(pool).plan(1);
  await pool.query('UPDATE campaigns SET dispatch_enabled = true WHERE id = 1');
});

const dueCount = () =>
  count(pool, `SELECT count(*) AS n FROM sends WHERE status = 'planned' AND scheduled_at <= $1`, [AT]);
const outboxRows = () => count(pool, 'SELECT count(*) AS n FROM send_outbox');
const jobCount = async () => (await queue.getJobCounts('waiting', 'delayed', 'active')).waiting ?? 0;

describe('due-send dispatcher', () => {
  it('queues every due send exactly once, with one outbox row each, and never early', async () => {
    const due = await dueCount();
    let queued = 0;
    for (;;) {
      const r = await dispatchDueBatch(pool, { now: AT, batchSize: 100, missedSlotGraceMs: NO_GRACE_LIMIT });
      queued += r.queued;
      if (r.examined === 0) break;
    }
    expect(queued).toBe(due);
    expect(await outboxRows()).toBe(due);
    expect(await count(pool, `SELECT count(*) AS n FROM sends WHERE dispatch_state = 'queued' AND scheduled_at > $1`, [AT])).toBe(0);
    expect(await count(pool, `SELECT count(*) AS n FROM sends WHERE dispatch_state = 'waiting' AND scheduled_at > $1`, [AT])).toBeGreaterThan(0);
    const { rows } = await pool.query(`SELECT DISTINCT dispatch_generation FROM sends WHERE dispatch_state = 'queued'`);
    expect(rows).toEqual([{ dispatch_generation: 1 }]);
  });

  it('lets concurrent dispatchers share the work without double-queuing', async () => {
    const due = await dueCount();
    const results = await Promise.all(
      Array.from({ length: 6 }, async () => {
        let n = 0;
        for (;;) {
          const r = await dispatchDueBatch(pool, { now: AT, batchSize: 50, missedSlotGraceMs: NO_GRACE_LIMIT });
          n += r.queued;
          if (r.examined === 0) return n;
        }
      }),
    );
    expect(results.reduce((a, b) => a + b, 0)).toBe(due);
    expect(await outboxRows()).toBe(due);
    expect(await count(pool, 'SELECT count(DISTINCT send_id) AS n FROM send_outbox')).toBe(due);
  });

  it('applies the missed-slot policy instead of sending late', async () => {
    const r = await dispatchDueBatch(pool, { now: AT, batchSize: 10_000, missedSlotGraceMs: 10 * 60_000 });
    // Only slots within 10 minutes of 08:05Z go out: 08:00/08:02/08:04Z in London; 07:56..08:04Z in
    // Sydney; Kathmandu's odd-minute UTC slots 07:55..08:05Z (13:40..13:50 local, inclusive).
    expect(r.queued).toBe(3 + 5 + 6);
    expect(r.missed).toBe(r.examined - r.queued);
    const { rows } = await pool.query(
      `SELECT status, scheduled_at, suppression_reason, missed_scheduled_at IS NOT NULL AS kept, dispatch_state
         FROM sends WHERE suppression_reason = 'missed_slot' LIMIT 1`,
    );
    expect(rows[0]).toEqual({ status: 'not_scheduled', scheduled_at: null, suppression_reason: 'missed_slot', kept: true, dispatch_state: 'suppressed' });
    // Each miss is published as a status change for dashboards.
    expect(await count(pool, 'SELECT count(*) AS n FROM status_event_outbox')).toBe(r.missed);
  });

  it('never dispatches outside the branch-local window, even within grace', async () => {
    // 19:00Z on Fri 23 Oct is 20:00 in London (BST): the window has closed.
    const late = new Date('2026-10-23T19:00:00Z');
    await pool.query(`UPDATE campaigns SET dispatch_enabled = true WHERE id = 1`);
    const r = await dispatchDueBatch(pool, { now: late, batchSize: 10_000, missedSlotGraceMs: NO_GRACE_LIMIT });
    const londonQueued = await count(pool, `SELECT count(*) AS n FROM sends WHERE branch_id = 1 AND dispatch_state = 'queued'`);
    expect(londonQueued).toBe(0);
    expect(r.queued).toBe(0); // Kathmandu (00:45) and Sydney (06:00 Sat) are closed too
  });

  it('skips paused, cancelled, and not-enabled campaigns', async () => {
    for (const sql of [
      'UPDATE campaigns SET paused_at = now()',
      'UPDATE campaigns SET paused_at = NULL, cancelled_at = now()',
      'UPDATE campaigns SET cancelled_at = NULL, dispatch_enabled = false',
    ]) {
      await pool.query(sql);
      expect((await dispatchDueBatch(pool, { now: AT, missedSlotGraceMs: NO_GRACE_LIMIT })).examined).toBe(0);
    }
  });

  it('leaves nothing behind when the dispatch transaction fails before commit', async () => {
    const failing = Object.create(pool);
    failing.connect = async () => {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...a: unknown[]) => unknown;
      (client as any).query = (text: unknown, ...rest: unknown[]) =>
        typeof text === 'string' && text.includes('INSERT INTO send_outbox')
          ? Promise.reject(new Error('crash before outbox commit'))
          : query(text, ...rest);
      const release = client.release;
      (client as any).release = (err?: Error) => {
        delete (client as any).query;
        (client as any).release = release;
        return release(err);
      };
      return client;
    };
    await expect(dispatchDueBatch(failing, { now: AT, missedSlotGraceMs: NO_GRACE_LIMIT })).rejects.toThrow(/crash/);
    expect(await outboxRows()).toBe(0);
    expect(await count(pool, `SELECT count(*) AS n FROM sends WHERE dispatch_state <> 'waiting' AND status = 'planned'`)).toBe(0);
  });
});

describe('outbox relay', () => {
  const dispatchAll = () => dispatchDueBatch(pool, { now: AT, batchSize: 10_000, missedSlotGraceMs: NO_GRACE_LIMIT });

  it('enqueues committed rows with deterministic job ids and marks them published', async () => {
    const { queued } = await dispatchAll();
    const relay = new OutboxRelay(new OutboxRepository(pool), queue, { batchSize: 1000 });
    expect(await relay.drain()).toBe(queued);
    expect(await jobCount()).toBe(queued);
    const { rows } = await pool.query(`SELECT send_id FROM send_outbox ORDER BY send_id LIMIT 1`);
    const job = await queue.getJob(`send-${rows[0].send_id}-1`);
    expect(job?.data).toEqual({ sendId: rows[0].send_id, campaignId: 1, dispatchGeneration: 1 });
    expect(await count(pool, 'SELECT count(*) AS n FROM send_outbox WHERE published_at IS NULL')).toBe(0);
  });

  it('recovers a crash after commit but before enqueue: the row is still pending', async () => {
    const { queued } = await dispatchAll(); // committed, relay never ran
    expect(await count(pool, 'SELECT count(*) AS n FROM send_outbox WHERE published_at IS NULL')).toBe(queued);
    await new OutboxRelay(new OutboxRepository(pool), queue).drain();
    expect(await jobCount()).toBe(queued);
  });

  it('recovers a crash after enqueue but before marking published without duplicating jobs', async () => {
    const { queued } = await dispatchAll();
    const crashing = new OutboxRelay(new OutboxRepository(pool), queue, {
      batchSize: 1000,
      leaseMs: 200,
      hooks: { afterEnqueue: () => { throw new Error('killed after enqueue'); } },
    });
    const first = await crashing.runOnce();
    expect(first.published).toBe(0);
    expect(await jobCount()).toBe(queued); // jobs reached Redis
    await pool.query(`UPDATE send_outbox SET available_at = now()`); // skip the failure backoff
    await new OutboxRelay(new OutboxRepository(pool), queue).drain();
    expect(await jobCount()).toBe(queued); // same job ids: BullMQ kept one of each
    expect(await count(pool, 'SELECT count(*) AS n FROM send_outbox WHERE published_at IS NULL')).toBe(0);
  });

  it('keeps rows pending while Redis is down and publishes after it recovers', async () => {
    const { queued } = await dispatchAll();
    let redisUp = false;
    const flaky: JobQueue = {
      add: (name, data, opts) => (redisUp ? queue.add(name, data, opts) : Promise.reject(new Error('ECONNREFUSED'))),
    };
    const relay = new OutboxRelay(new OutboxRepository(pool), flaky, { batchSize: 1000 });
    const down = await relay.runOnce();
    expect(down).toMatchObject({ published: 0, failed: queued });
    const { rows } = await pool.query(`SELECT max(publish_attempts) AS a, bool_and(last_error = 'ECONNREFUSED') AS e FROM send_outbox`);
    expect(rows[0]).toEqual({ a: 1, e: true });

    redisUp = true;
    await pool.query(`UPDATE send_outbox SET available_at = now()`);
    expect(await relay.drain()).toBe(queued);
    expect(await jobCount()).toBe(queued);
  });

  it('lets parallel relays share rows via leases', async () => {
    const { queued } = await dispatchAll();
    const relays = Array.from({ length: 4 }, () => new OutboxRelay(new OutboxRepository(pool), queue, { batchSize: 3 }));
    const published = await Promise.all(relays.map((r) => r.drain()));
    expect(published.reduce((a, b) => a + b, 0)).toBe(queued);
  });
});

describe('reconciliation', () => {
  const lookup = { getJobState: async (id: string) => ((await queue.getJob(id)) ? queue.getJobState(id) : null) };

  it('re-dispatches queued sends whose job vanished from Redis under a new generation', async () => {
    const { queued } = await dispatchDueBatch(pool, { now: AT, missedSlotGraceMs: NO_GRACE_LIMIT, batchSize: 10_000 });
    await new OutboxRelay(new OutboxRepository(pool), queue).drain();

    // Nothing to repair while jobs exist.
    expect((await reconcileStuckDispatches(pool, lookup, { staleMs: 0 })).repaired).toEqual([]);

    // Simulate Redis data loss for two jobs.
    const { rows } = await pool.query(`SELECT id FROM sends WHERE dispatch_state = 'queued' ORDER BY id LIMIT 2`);
    for (const r of rows) await queue.remove(`send-${r.id}-1`);
    const result = await reconcileStuckDispatches(pool, lookup, { staleMs: 0 });
    expect(result.repaired).toEqual(rows.map((r) => r.id));

    const { rows: gens } = await pool.query(`SELECT id, dispatch_generation, dispatch_state FROM sends WHERE id = ANY($1) ORDER BY id`, [rows.map((r) => r.id)]);
    expect(gens.map((g) => [g.dispatch_generation, g.dispatch_state])).toEqual([[2, 'queued'], [2, 'queued']]);
    await new OutboxRelay(new OutboxRepository(pool), queue).drain();
    expect(await queue.getJob(`send-${rows[0].id}-2`)).toBeTruthy();
    expect(await jobCount()).toBe(queued);
  });

  it('reclaims an expired worker claim whose job is gone, closing the abandoned attempt', async () => {
    await dispatchDueBatch(pool, { now: AT, missedSlotGraceMs: NO_GRACE_LIMIT, batchSize: 1 });
    const { rows } = await pool.query(`SELECT id FROM sends WHERE dispatch_state = 'queued'`);
    const id = rows[0].id;
    await pool.query(
      `UPDATE sends SET dispatch_state = 'claimed', claim_token = gen_random_uuid(), claimed_by = 'dead-worker', claim_expires_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    );
    await pool.query(
      `INSERT INTO send_attempts (send_id, attempt_number, dispatch_generation, worker_id, lease_token, idempotency_key)
       VALUES ($1, 1, 1, 'dead-worker', gen_random_uuid(), 'k')`,
      [id],
    );
    await pool.query(`UPDATE send_outbox SET published_at = now() - interval '1 hour'`);
    const result = await reconcileStuckDispatches(pool, lookup, { staleMs: 1000 });
    expect(result.repaired).toEqual([id]);
    const { rows: after } = await pool.query(`SELECT dispatch_state, dispatch_generation, claim_token FROM sends WHERE id = $1`, [id]);
    expect(after[0]).toEqual({ dispatch_state: 'queued', dispatch_generation: 2, claim_token: null });
    expect((await pool.query(`SELECT outcome FROM send_attempts WHERE send_id = $1`, [id])).rows[0].outcome).toBe('lease_lost');
  });

  it('does not touch fresh dispatches or unexpired claims', async () => {
    await dispatchDueBatch(pool, { now: AT, missedSlotGraceMs: NO_GRACE_LIMIT, batchSize: 1 });
    const empty = { getJobState: async () => null };
    expect((await reconcileStuckDispatches(pool, empty, { staleMs: 60_000 })).repaired).toEqual([]); // not yet published
    await pool.query(`UPDATE send_outbox SET published_at = now()`);
    expect((await reconcileStuckDispatches(pool, empty, { staleMs: 60_000 })).repaired).toEqual([]); // too recent
  });
});
