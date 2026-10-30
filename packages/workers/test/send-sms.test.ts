import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { CampaignRepository } from '../../api/src/campaigns/repository';
import { ClaimService } from '../../api/src/delivery/claim-service';
import type { SendJobData } from '../../api/src/delivery/types';
import { count, freshSeed, testPool } from '../../api/test/helpers';
import { createSendSmsProcessor, RetryableJobError } from '../src/processors/send-sms';
import { HttpSmsProvider } from '../src/providers/http-provider';
import { maskPhone, parseRetryAfter, ProviderError } from '../src/providers/provider';
import { SimulatedProvider } from '../src/providers/simulated-provider';
import { createSmsWorker } from '../src/worker';

process.env.LOG_LEVEL = 'silent';
const pool = testPool(30);
afterAll(() => pool.end());

/** London member 1's slot (Fri 23 Oct 09:00 BST); "now" is one minute later, inside the window. */
const SLOT = new Date('2026-10-23T08:00:00Z');
const NOW = new Date(SLOT.getTime() + 60_000);
let sendId: number;

async function arm(id: number, generation = 1) {
  await pool.query(`UPDATE sends SET dispatch_state = 'queued', dispatch_generation = $2 WHERE id = $1`, [id, generation]);
}

const fakeJob = (data: Partial<SendJobData> = {}, attemptsMade = 0, id = `send-${sendId}-1`) =>
  ({ id, data: { sendId, campaignId: 1, dispatchGeneration: 1, ...data }, attemptsMade }) as Job<SendJobData>;

const claims = (over: Partial<ConstructorParameters<typeof ClaimService>[1]> = {}) =>
  new ClaimService(pool, { workerId: 'w-test', leaseMs: 30_000, now: () => NOW, ...over });

const sendRow = async (id = sendId) =>
  (await pool.query(`SELECT status, dispatch_state, claim_token, provider_message_id, scheduled_at, status_version FROM sends WHERE id = $1`, [id])).rows[0];
const attempts = async (id = sendId) =>
  (await pool.query(`SELECT outcome, idempotency_key FROM send_attempts WHERE send_id = $1 ORDER BY attempt_number`, [id])).rows;

beforeEach(async () => {
  await freshSeed(pool);
  await new CampaignRepository(pool).plan(1);
  await pool.query('UPDATE campaigns SET dispatch_enabled = true WHERE id = 1');
  sendId = (await pool.query(`SELECT id FROM sends WHERE member_id = 1`)).rows[0].id;
  await arm(sendId);
});

describe('provider error classification', () => {
  const respond = (status: number, body = '', headers: Record<string, string> = {}) =>
    new HttpSmsProvider({
      url: 'https://sms.example.test/messages',
      apiKey: 'k',
      fetchFn: async () => new Response(body, { status, headers }),
    });
  const input = { to: '+447700000001', body: 'hi', idempotencyKey: 'campaign-send:1', correlationId: 'c' };
  const kindOf = async (p: HttpSmsProvider) => p.send(input).then(() => 'accepted', (e: ProviderError) => [e.kind, e.code, e.retryAfterMs]);

  it('maps provider responses onto retry semantics', async () => {
    expect(await respond(202, '{"id":"pm-1"}').send(input)).toEqual({ providerMessageId: 'pm-1', providerRequestId: undefined });
    expect(await kindOf(respond(429, '', { 'retry-after': '7' }))).toEqual(['rate_limited', '429', 7000]);
    expect(await kindOf(respond(503))).toEqual(['retryable', '503', undefined]);
    expect(await kindOf(respond(500))).toEqual(['retryable', '500', undefined]);
    expect(await kindOf(respond(504))).toEqual(['ambiguous', '504', undefined]);
    expect(await kindOf(respond(400))).toEqual(['permanent', '400', undefined]);
    expect(await kindOf(respond(422))).toEqual(['permanent', '422', undefined]);
    expect(await kindOf(respond(200, 'not json'))).toEqual(['ambiguous', 'bad_response', undefined]);
  });

  it('treats unreachable as retryable and a lost response as ambiguous', async () => {
    const refused = new HttpSmsProvider({
      url: 'https://sms.example.test', apiKey: 'k',
      fetchFn: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); },
    });
    expect(await kindOf(refused)).toEqual(['retryable', 'ECONNREFUSED', undefined]);
    const timeout = new HttpSmsProvider({
      url: 'https://sms.example.test', apiKey: 'k',
      fetchFn: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
    });
    expect(await kindOf(timeout)).toEqual(['ambiguous', 'TIMEOUT', undefined]);
  });

  it('sends the idempotency key and refuses plaintext production endpoints', async () => {
    let headers: Headers | undefined;
    const p = new HttpSmsProvider({
      url: 'https://sms.example.test', apiKey: 'secret',
      fetchFn: async (_u, init) => { headers = new Headers(init?.headers); return new Response('{"id":"x"}'); },
    });
    await p.send(input);
    expect(headers?.get('idempotency-key')).toBe('campaign-send:1');
    expect(headers?.get('authorization')).toBe('Bearer secret');
    expect(() => new HttpSmsProvider({ url: 'http://sms.example.test', apiKey: 'k' })).toThrow(/https/);
  });

  it('parses Retry-After and masks phones', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('99999')).toBe(600_000);
    expect(parseRetryAfter(new Date(Date.now() + 30_000).toUTCString())).toBeGreaterThan(25_000);
    expect(maskPhone('+447700000123')).toBe('+44********23');
  });
});

describe('send processor with database claims', () => {
  it('sends once, records the attempt, and moves planned -> sent', async () => {
    const provider = new SimulatedProvider();
    const out = await createSendSmsProcessor({ claims: claims(), provider, maxAttempts: 5 })(fakeJob());
    expect(out).toEqual({ result: 'sent' });
    const row = await sendRow();
    expect(row).toMatchObject({ status: 'sent', dispatch_state: 'complete', claim_token: null, status_version: 2 });
    expect(row.provider_message_id).toMatch(/^sim-/);
    expect(await attempts()).toEqual([{ outcome: 'accepted', idempotency_key: `campaign-send:${sendId}` }]);
    expect(provider.requests[0]).toMatchObject({ to: '+447700000001', idempotencyKey: `campaign-send:${sendId}` });
    expect(provider.requests[0].body).toMatch(/^Hi \w+, we miss you at London Central!/);
    expect(await count(pool, 'SELECT count(*) AS n FROM status_event_outbox WHERE send_id = $1', [sendId])).toBe(1);
  });

  it('calls the provider once for concurrent duplicate jobs of the same dispatch', async () => {
    const provider = new SimulatedProvider().enqueue({ type: 'delay', ms: 200 });
    const run = createSendSmsProcessor({ claims: claims(), provider, maxAttempts: 5 });
    const results = await Promise.allSettled([run(fakeJob()), run(fakeJob({}, 0, 'dup-a')), run(fakeJob({}, 0, 'dup-b'))]);
    expect(provider.requests).toHaveLength(1);
    // The others either saw the live claim (and will retry later) or the finished send.
    const values = results.map((r) => (r.status === 'fulfilled' ? r.value.result : (r.reason as Error).name));
    expect(values.filter((v) => v === 'sent')).toHaveLength(1);
    expect(values.every((v) => ['sent', 'skipped', 'RetryableJobError'].includes(v))).toBe(true);
    expect(await attempts()).toHaveLength(1);
  });

  it('ignores a stale job from an older dispatch generation', async () => {
    await arm(sendId, 2);
    const provider = new SimulatedProvider();
    expect(await createSendSmsProcessor({ claims: claims(), provider, maxAttempts: 5 })(fakeJob())).toEqual({
      result: 'skipped', reason: 'stale_generation',
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('reclaims after a crashed worker lease expires, and the idempotency key prevents a double send', async () => {
    const provider = new SimulatedProvider();
    // Worker A claims and the provider accepts, then A dies before recording anything.
    const a = claims({ workerId: 'A', leaseMs: 1_000 });
    const claimedA = await a.claim({ sendId, campaignId: 1, dispatchGeneration: 1 });
    if (claimedA.kind !== 'claimed') throw new Error('expected claim');
    await provider.send({ to: claimedA.claim.to, body: claimedA.claim.body, idempotencyKey: claimedA.claim.idempotencyKey, correlationId: 'a' });

    // While A's lease is live, B can't take it.
    const bSoon = claims({ workerId: 'B', now: () => new Date(NOW.getTime() + 500) });
    await expect(createSendSmsProcessor({ claims: bSoon, provider, maxAttempts: 5 })(fakeJob())).rejects.toBeInstanceOf(RetryableJobError);

    // After expiry (BullMQ stalled-job recovery hands B the job), B retries with the same key.
    const bLater = claims({ workerId: 'B', now: () => new Date(NOW.getTime() + 5_000) });
    expect(await createSendSmsProcessor({ claims: bLater, provider, maxAttempts: 5 })(fakeJob())).toEqual({ result: 'sent' });
    expect(provider.requests).toHaveLength(2);
    expect(provider.acceptanceCount).toBe(1);
    expect((await attempts()).map((a) => a.outcome)).toEqual(['lease_lost', 'accepted']);
    expect((await sendRow()).provider_message_id).toBe([...provider.accepted.values()][0].providerMessageId);
  });

  it('retries an accepted-then-timed-out send with the same key without a second acceptance', async () => {
    const provider = new SimulatedProvider().enqueue({ type: 'accept_then_timeout' });
    const run = createSendSmsProcessor({ claims: claims(), provider, maxAttempts: 5 });
    await expect(run(fakeJob())).rejects.toThrow(/ambiguous/);
    expect(await sendRow()).toMatchObject({ status: 'planned', dispatch_state: 'retry_wait' });
    expect(await run(fakeJob({}, 1))).toEqual({ result: 'sent' });
    expect(provider.acceptanceCount).toBe(1);
    expect(new Set(provider.requests.map((r) => r.idempotencyKey)).size).toBe(1);
    expect((await attempts()).map((a) => a.outcome)).toEqual(['ambiguous', 'accepted']);
  });

  it('parks an ambiguous send for manual reconciliation once the provider key window has passed', async () => {
    const provider = new SimulatedProvider().enqueue({ type: 'accept_then_timeout' });
    await expect(createSendSmsProcessor({ claims: claims({ idempotencyWindowMs: 60_000 }), provider, maxAttempts: 5 })(fakeJob())).rejects.toThrow();
    // Two minutes later (still inside the slot grace), a retry must not resend blindly.
    const later = claims({ idempotencyWindowMs: 60_000, now: () => new Date(NOW.getTime() + 120_000) });
    expect(await createSendSmsProcessor({ claims: later, provider, maxAttempts: 5 })(fakeJob({}, 1))).toEqual({
      result: 'suppressed', reason: 'ambiguous_window_expired',
    });
    expect(provider.requests).toHaveLength(1);
    expect(await sendRow()).toMatchObject({ status: 'planned', dispatch_state: 'dead_letter' });
  });

  it('rechecks consent before sending and keeps the slot for audit', async () => {
    await pool.query(`UPDATE members SET sms_opt_out = true WHERE id = 1`);
    const provider = new SimulatedProvider();
    expect(await createSendSmsProcessor({ claims: claims(), provider, maxAttempts: 5 })(fakeJob())).toEqual({
      result: 'suppressed', reason: 'opted_out_after_plan',
    });
    expect(provider.requests).toHaveLength(0);
    const row = await sendRow();
    expect(row).toMatchObject({ status: 'skipped_opt_out', dispatch_state: 'suppressed' });
    expect(row.scheduled_at).toEqual(SLOT);
  });

  it('hands the send back when the campaign is paused, and suppresses it when cancelled', async () => {
    const provider = new SimulatedProvider();
    await pool.query(`UPDATE campaigns SET paused_at = now()`);
    expect(await createSendSmsProcessor({ claims: claims(), provider, maxAttempts: 5 })(fakeJob())).toEqual({ result: 'skipped', reason: 'paused' });
    expect(await sendRow()).toMatchObject({ status: 'planned', dispatch_state: 'waiting' });

    await arm(sendId, 2);
    await pool.query(`UPDATE campaigns SET paused_at = NULL, cancelled_at = now()`);
    expect(await createSendSmsProcessor({ claims: claims(), provider, maxAttempts: 5 })(fakeJob({ dispatchGeneration: 2 }))).toMatchObject({
      result: 'suppressed', reason: 'campaign_cancelled',
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('never sends late: a queue backlog past the grace period marks the slot missed', async () => {
    const late = claims({ now: () => new Date(SLOT.getTime() + 11 * 60_000) });
    const provider = new SimulatedProvider();
    expect(await createSendSmsProcessor({ claims: late, provider, maxAttempts: 5 })(fakeJob())).toEqual({ result: 'suppressed', reason: 'missed_slot' });
    expect(provider.requests).toHaveLength(0);
    expect(await sendRow()).toMatchObject({ status: 'not_scheduled', scheduled_at: null });
  });

  it('does not overwrite a final webhook status that arrived before the worker recorded sent', async () => {
    const provider = new SimulatedProvider().enqueue({ type: 'delay', ms: 100 });
    const pending = createSendSmsProcessor({ claims: claims(), provider, maxAttempts: 5 })(fakeJob());
    await new Promise((r) => setTimeout(r, 30));
    await pool.query(`UPDATE sends SET status = 'delivered' WHERE id = $1`, [sendId]); // webhook won the race
    expect(await pending).toEqual({ result: 'sent' });
    expect(await sendRow()).toMatchObject({ status: 'delivered', dispatch_state: 'complete', status_version: 2 });
  });

  it('fails permanently on a 4xx, and dead-letters after retries are exhausted', async () => {
    const permanent = new SimulatedProvider().enqueue({ type: 'error', error: new ProviderError('permanent', '400', 'invalid number') });
    expect(await createSendSmsProcessor({ claims: claims(), provider: permanent, maxAttempts: 5 })(fakeJob())).toEqual({ result: 'failed', reason: '400' });
    expect(await sendRow()).toMatchObject({ status: 'failed', dispatch_state: 'complete' });

    const other = (await pool.query(`SELECT id FROM sends WHERE member_id = 2`)).rows[0].id;
    await arm(other);
    const flaky = new SimulatedProvider().enqueue(
      { type: 'error', error: new ProviderError('retryable', '503', 'down') },
      { type: 'error', error: new ProviderError('retryable', '503', 'down') },
    );
    const otherClaims = claims({ now: () => new Date('2026-10-23T08:03:00Z') });
    const run = createSendSmsProcessor({ claims: otherClaims, provider: flaky, maxAttempts: 2 });
    await expect(run(fakeJob({ sendId: other }, 0))).rejects.toBeInstanceOf(RetryableJobError);
    expect(await run(fakeJob({ sendId: other }, 1))).toEqual({ result: 'dead_letter', reason: 'retryable_error' });
    expect(await sendRow(other)).toMatchObject({ status: 'failed', dispatch_state: 'dead_letter' });
    expect((await attempts(other)).map((a) => a.outcome)).toEqual(['retryable_error', 'retryable_error']);
  });

  it("dead-letters at the job's own attempt limit so BullMQ and PostgreSQL agree", async () => {
    const provider = new SimulatedProvider().enqueue({ type: 'error', error: new ProviderError('retryable', '503', 'down') });
    const job = { ...fakeJob(), opts: { attempts: 1 } } as Job<SendJobData>;
    expect(await createSendSmsProcessor({ claims: claims(), provider, maxAttempts: 8 })(job)).toEqual({ result: 'dead_letter', reason: 'retryable_error' });
    expect(await sendRow()).toMatchObject({ status: 'failed', dispatch_state: 'dead_letter' });
  });

  it('keeps an ambiguous send planned (not failed) when retries run out', async () => {
    const provider = new SimulatedProvider().enqueue({ type: 'error', error: new ProviderError('ambiguous', 'TIMEOUT', 'lost') });
    expect(await createSendSmsProcessor({ claims: claims(), provider, maxAttempts: 1 })(fakeJob())).toEqual({ result: 'dead_letter', reason: 'ambiguous' });
    expect(await sendRow()).toMatchObject({ status: 'planned', dispatch_state: 'dead_letter' });
  });
});

describe('BullMQ worker', () => {
  let redis: IORedis;
  let queue: Queue<SendJobData>;
  let events: QueueEvents;
  const QUEUE = 'sms-send.worker-test';

  beforeAll(async () => {
    redis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue<SendJobData>(QUEUE, { connection: redis });
    events = new QueueEvents(QUEUE, { connection: redis.duplicate() });
    await events.waitUntilReady();
  });
  afterAll(async () => {
    await events.close();
    await queue.close();
    await redis.quit();
  });
  beforeEach(() => queue.obliterate({ force: true }));

  const add = (id = sendId, gen = 1) =>
    queue.add('send-sms', { sendId: id, campaignId: 1, dispatchGeneration: gen }, { jobId: `send-${id}-${gen}`, attempts: 4, backoff: { type: 'fixed', delay: 50 } });

  it('retries with backoff until the provider accepts', async () => {
    const provider = new SimulatedProvider().enqueue(
      { type: 'error', error: new ProviderError('retryable', '503', 'down') },
      { type: 'error', error: new ProviderError('retryable', 'ECONNREFUSED', 'down') },
    );
    const worker = createSmsWorker({ connection: redis.duplicate(), queueName: QUEUE, claims: claims(), provider, concurrency: 2, maxAttempts: 4 });
    void worker.run();
    const job = await add();
    expect(await job.waitUntilFinished(events, 10_000)).toEqual({ result: 'sent' });
    await worker.close();
    expect((await attempts()).map((a) => a.outcome)).toEqual(['retryable_error', 'retryable_error', 'accepted']);
  });

  it('backs the whole queue off on 429 without spending a job attempt', async () => {
    const provider = new SimulatedProvider().enqueue({ type: 'error', error: new ProviderError('rate_limited', '429', 'slow down', 300) });
    const worker = createSmsWorker({ connection: redis.duplicate(), queueName: QUEUE, claims: claims(), provider, concurrency: 1, maxAttempts: 4 });
    void worker.run();
    const started = Date.now();
    const job = await add();
    expect(await job.waitUntilFinished(events, 10_000)).toEqual({ result: 'sent' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await worker.close();
    // attemptsMade includes the successful run; the rate-limited pass did not consume one.
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(1);
    expect((await attempts()).map((a) => a.outcome)).toEqual(['rate_limited', 'accepted']);
  });

  it('enforces the configured provider rate limit across the queue', async () => {
    const ids = (await pool.query(`SELECT id FROM sends WHERE branch_id = 1 AND status = 'planned' ORDER BY id LIMIT 6`)).rows.map((r) => r.id);
    // Slots are 2 minutes apart; give each its own clock-correct claim service via a wide grace.
    for (const id of ids) await arm(id);
    const wide = claims({ missedSlotGraceMs: 60 * 60_000, now: () => new Date('2026-10-23T08:11:00Z') });
    const provider = new SimulatedProvider();
    const worker = createSmsWorker({
      connection: redis.duplicate(), queueName: QUEUE, claims: wide, provider, concurrency: 6, maxAttempts: 2,
      limiter: { max: 2, duration: 500 },
    });
    void worker.run();
    const started = Date.now();
    const jobs = await Promise.all(ids.map((id) => add(id)));
    await Promise.all(jobs.map((j) => j.waitUntilFinished(events, 10_000)));
    expect(Date.now() - started).toBeGreaterThanOrEqual(900); // 6 jobs at 2 per 500ms
    expect(provider.acceptanceCount).toBe(6);
    await worker.close();
  });

  it('shuts down gracefully: waits for the in-flight provider call and records it', async () => {
    const provider = new SimulatedProvider().enqueue({ type: 'delay', ms: 400 });
    const worker = createSmsWorker({ connection: redis.duplicate(), queueName: QUEUE, claims: claims(), provider, concurrency: 1, maxAttempts: 4 });
    void worker.run();
    await add();
    while (provider.requests.length === 0) await new Promise((r) => setTimeout(r, 10));
    await worker.close(); // SIGTERM path
    expect(provider.acceptanceCount).toBe(1);
    expect(await attempts()).toEqual([{ outcome: 'accepted', idempotency_key: `campaign-send:${sendId}` }]);
    expect(await count(pool, `SELECT count(*) AS n FROM send_attempts WHERE outcome = 'in_progress'`)).toBe(0);
    expect(await sendRow()).toMatchObject({ status: 'sent', claim_token: null });
  });
});
