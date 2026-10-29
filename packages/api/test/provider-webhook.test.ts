import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { createApp } from '../src/app';
import { CampaignRepository } from '../src/campaigns/repository';
import type { SendStatusChanged } from '../src/live/events';
import { count, freshSeed, testPool } from './helpers';

const pool = testPool(60);
const published: SendStatusChanged[] = [];
const app = createApp({ pool, publisher: { publish: (u) => published.push(u) } });

let sendId: number;
let otherSendId: number;

beforeEach(async () => {
  await freshSeed(pool);
  await new CampaignRepository(pool).plan(1);
  published.length = 0;
  const { rows } = await pool.query(`SELECT id FROM sends WHERE status = 'planned' ORDER BY id LIMIT 2`);
  [sendId, otherSendId] = rows.map((r) => r.id);
});
afterAll(() => pool.end());

const event = (overrides: Partial<{ eventId: string; sendId: number; status: string; occurredAt: string }> = {}) => ({
  eventId: `evt-${Math.random().toString(36).slice(2)}`,
  sendId,
  status: 'sent',
  occurredAt: '2026-10-23T08:00:05Z',
  ...overrides,
});

const post = (body: unknown, raw = false) =>
  request(app)
    .post('/webhooks/provider')
    .set('content-type', 'application/json')
    .send(raw ? (body as string) : JSON.stringify(body));

const sendRow = (id = sendId) =>
  pool.query('SELECT status, status_version FROM sends WHERE id = $1', [id]).then((r) => r.rows[0]);
const receipts = () => count(pool, 'SELECT count(*) AS n FROM webhook_receipts');

describe('POST /webhooks/provider', () => {
  it('applies a valid event, records the raw body exactly, and publishes after commit', async () => {
    const raw = `{ "eventId": "evt-1", "sendId": ${sendId}, "status": "sent", "occurredAt": "2026-10-23T09:00:05+01:00" }`;
    const res = await post(raw, true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: 'applied', eventId: 'evt-1', statusVersion: 2 });
    expect(await sendRow()).toEqual({ status: 'sent', status_version: 2 });

    const { rows } = await pool.query('SELECT raw_body FROM webhook_receipts');
    expect(rows.map((r) => r.raw_body.toString('utf8'))).toEqual([raw]);
    const { rows: events } = await pool.query('SELECT event_id, send_id, status, occurred_at, disposition, reason FROM provider_events');
    expect(events).toEqual([
      { event_id: 'evt-1', send_id: sendId, status: 'sent', occurred_at: new Date('2026-10-23T08:00:05Z'), disposition: 'applied', reason: null },
    ]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ campaignId: 1, sendId, branchId: 1, status: 'sent', statusVersion: 2 });
    expect(published[0].updatedAt).toMatch(/Z$/);
  });

  it('keeps a receipt for every repeat but applies an eventId once', async () => {
    const e = event();
    for (let i = 0; i < 3; i++) {
      const res = await post(e);
      expect(res.status).toBe(200);
      expect(res.body.result).toBe(i === 0 ? 'applied' : 'duplicate');
    }
    expect(await receipts()).toBe(3);
    expect(await count(pool, 'SELECT count(*) AS n FROM provider_events')).toBe(1);
    expect(published).toHaveLength(1);
  });

  it('does not reprocess a reused eventId with a different body, but stores its receipt', async () => {
    await post(event({ eventId: 'evt-x', status: 'sent' })).expect(200);
    const res = await post(event({ eventId: 'evt-x', status: 'failed' }));
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('duplicate');
    expect(await sendRow()).toEqual({ status: 'sent', status_version: 2 });
    const { rows } = await pool.query('SELECT raw_body FROM webhook_receipts ORDER BY id');
    expect(rows.map((r) => JSON.parse(r.raw_body.toString()).status)).toEqual(['sent', 'failed']);
  });

  it('applies concurrent duplicates exactly once', async () => {
    const e = event();
    const responses = await Promise.all(Array.from({ length: 20 }, () => post(e)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.body.result === 'applied')).toHaveLength(1);
    expect(responses.filter((r) => r.body.result === 'duplicate')).toHaveLength(19);
    expect(await receipts()).toBe(20);
    expect(await sendRow()).toEqual({ status: 'sent', status_version: 2 });
    expect(published).toHaveLength(1);
  });

  it('ignores a stale sent that arrives after the final status', async () => {
    await post(event({ status: 'delivered', occurredAt: '2026-10-23T08:01:00Z' })).expect(200);
    const late = await post(event({ status: 'sent', occurredAt: '2026-10-23T08:00:05Z' }));
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ result: 'ignored', reason: 'stale' });
    expect(await sendRow()).toEqual({ status: 'delivered', status_version: 2 });
    const { rows } = await pool.query(`SELECT disposition, reason FROM provider_events WHERE status = 'sent'`);
    expect(rows).toEqual([{ disposition: 'ignored', reason: 'stale' }]);
  });

  it('keeps the first committed final status regardless of occurredAt', async () => {
    await post(event({ status: 'sent' })).expect(200);
    await post(event({ status: 'undelivered', occurredAt: '2026-10-23T09:00:00Z' })).expect(200);
    const competing = await post(event({ status: 'delivered', occurredAt: '2026-10-23T08:30:00Z' }));
    expect(competing.body).toMatchObject({ result: 'ignored', reason: 'stale' });
    expect(await sendRow()).toEqual({ status: 'undelivered', status_version: 3 });
  });

  it('settles concurrent competing finals on exactly one winner', async () => {
    const finals = ['delivered', 'undelivered', 'failed', 'delivered', 'failed', 'undelivered'];
    const responses = await Promise.all(
      finals.flatMap((status) => [post(event({ status })), post(event({ sendId: otherSendId, status }))]),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.body.result === 'applied')).toHaveLength(2);
    for (const id of [sendId, otherSendId]) {
      const row = await sendRow(id);
      expect(['delivered', 'undelivered', 'failed']).toContain(row.status);
      expect(row.status_version).toBe(2);
    }
    expect(published).toHaveLength(2);
  });

  it('never regresses under shuffled concurrent sent/final traffic', async () => {
    const ids = (await pool.query(`SELECT id FROM sends WHERE status = 'planned' ORDER BY id LIMIT 40`)).rows.map((r) => r.id);
    const bodies = ids.flatMap((id) => [
      { eventId: `s-${id}`, sendId: id, status: 'sent', occurredAt: '2026-10-23T08:00:00Z' },
      { eventId: `f-${id}`, sendId: id, status: 'delivered', occurredAt: '2026-10-23T08:01:00Z' },
    ]);
    const shuffled = [...bodies, ...bodies].sort(() => Math.random() - 0.5);
    await Promise.all(shuffled.map((b) => post(b).expect(200)));
    const { rows } = await pool.query(`SELECT status, count(*)::int AS n FROM sends WHERE id = ANY($1) GROUP BY status`, [ids]);
    expect(rows).toEqual([{ status: 'delivered', n: 40 }]);
    expect(await count(pool, 'SELECT count(*) AS n FROM provider_events')).toBe(80);
  });

  it('acknowledges a well-formed event for an unknown send', async () => {
    const res = await post(event({ sendId: 987654 }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: 'ignored', reason: 'unknown_send' });
    const { rows } = await pool.query('SELECT disposition, reason FROM provider_events');
    expect(rows).toEqual([{ disposition: 'ignored', reason: 'unknown_send' }]);
    expect(await receipts()).toBe(1);
  });

  it('ignores provider events for sends that were never scheduled', async () => {
    const { rows } = await pool.query(`SELECT id FROM sends WHERE status = 'skipped_opt_out' LIMIT 1`);
    const res = await post(event({ sendId: rows[0].id }));
    expect(res.body).toMatchObject({ result: 'ignored', reason: 'stale' });
    expect((await sendRow(rows[0].id)).status).toBe('skipped_opt_out');
  });

  it.each([
    ['broken JSON', '{"eventId": '],
    ['empty body', ''],
    ['wrong status', JSON.stringify({ eventId: 'e', sendId: 1, status: 'read', occurredAt: '2026-10-23T08:00:00Z' })],
    ['missing field', JSON.stringify({ eventId: 'e', status: 'sent', occurredAt: '2026-10-23T08:00:00Z' })],
    ['string sendId', JSON.stringify({ eventId: 'e', sendId: '1', status: 'sent', occurredAt: '2026-10-23T08:00:00Z' })],
    ['timestamp without offset', JSON.stringify({ eventId: 'e', sendId: 1, status: 'sent', occurredAt: '2026-10-23T08:00:00' })],
    ['unknown field', JSON.stringify({ eventId: 'e', sendId: 1, status: 'sent', occurredAt: '2026-10-23T08:00:00Z', x: 1 })],
    ['JSON array', '[]'],
  ])('rejects %s with 400 but keeps the raw receipt', async (_name, raw) => {
    const res = await post(raw, true);
    expect(res.status).toBe(400);
    const { rows } = await pool.query('SELECT raw_body FROM webhook_receipts');
    expect(rows.map((r) => r.raw_body.toString('utf8'))).toEqual([raw]);
    expect(await count(pool, 'SELECT count(*) AS n FROM provider_events')).toBe(0);
  });

  it('stores non-JSON content types and binary bodies byte for byte', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x7b, 0x0a]);
    const res = await request(app).post('/webhooks/provider').set('content-type', 'application/octet-stream').send(bytes);
    expect(res.status).toBe(400);
    const { rows } = await pool.query('SELECT raw_body, content_type FROM webhook_receipts');
    expect(Buffer.compare(rows[0].raw_body, bytes)).toBe(0);
    expect(rows[0].content_type).toBe('application/octet-stream');
  });

  it('returns 503 on a transient failure, keeps the receipt, and lets the retry apply', async () => {
    // Pool whose transactional clients fail on the send UPDATE, after the event claim insert.
    const failing = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        const original = client.query.bind(client) as (...args: any[]) => any;
        const release = client.release;
        const patched = client as any;
        patched.query = (text: unknown, ...rest: unknown[]) =>
          typeof text === 'string' && text.includes('UPDATE sends')
            ? Promise.reject(Object.assign(new Error('connection reset'), { code: '08006' }))
            : original(text, ...rest);
        patched.release = (err?: Error) => {
          delete patched.query; // restore the prototype method before the client returns to the pool
          patched.release = release;
          return release(err);
        };
        return client;
      },
    } as unknown as Pool;
    const flaky = createApp({ pool: failing });
    const e = event();

    const failed = await request(flaky).post('/webhooks/provider').set('content-type', 'application/json').send(JSON.stringify(e));
    expect(failed.status).toBe(503);
    expect(await receipts()).toBe(1);
    expect(await count(pool, 'SELECT count(*) AS n FROM provider_events')).toBe(0);
    expect((await sendRow()).status).toBe('planned');

    const retry = await post(e);
    expect(retry.status).toBe(200);
    expect(retry.body.result).toBe('applied');
    expect(await receipts()).toBe(2);
  });

  it('returns 503 when even the receipt cannot be stored', async () => {
    const down = { query: () => Promise.reject(new Error('db down')), connect: () => Promise.reject(new Error('db down')) } as unknown as Pool;
    const res = await request(createApp({ pool: down })).post('/webhooks/provider').send(JSON.stringify(event()));
    expect(res.status).toBe(503);
    expect(res.body.retryable).toBe(true);
  });
});
