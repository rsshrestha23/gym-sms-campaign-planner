import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { createApp } from '../src/app';
import { CampaignRepository } from '../src/campaigns/repository';
import type { SendStatusChanged } from '../src/live/events';
import { StatusEventRelay } from '../src/webhooks/event-outbox';
import { parseSigningKeys, signRequest, verifySignature } from '../src/webhooks/signature-verifier';
import { count, freshSeed, testPool } from './helpers';

const pool = testPool(40);
afterAll(() => pool.end());

const CURRENT = 'whsec_current_0123456789';
const PREVIOUS = 'whsec_previous_9876543210';
const published: SendStatusChanged[] = [];
const app = createApp({
  pool,
  publisher: { publish: (u) => void published.push(u) },
  webhook: { signingKeys: parseSigningKeys(`${CURRENT},${PREVIOUS}`), toleranceSec: 300 },
});

let sendId: number;
beforeEach(async () => {
  await freshSeed(pool);
  await new CampaignRepository(pool).plan(1);
  published.length = 0;
  sendId = (await pool.query(`SELECT id FROM sends WHERE status = 'planned' ORDER BY id LIMIT 1`)).rows[0].id;
});

const body = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ eventId: `e-${Math.random().toString(36).slice(2)}`, sendId, status: 'delivered', occurredAt: '2026-10-23T08:01:00Z', ...o });

const post = (raw: string, headers: Record<string, string>) =>
  request(app).post('/v1/webhooks/provider').set({ 'content-type': 'application/json', ...headers }).send(raw);

const receipts = async () =>
  (await pool.query(`SELECT auth_status, signature_key_id, convert_from(raw_body, 'UTF8') AS raw FROM provider_event_receipts ORDER BY id`)).rows;

describe('signature verification', () => {
  it('accepts the current key and records which key signed', async () => {
    const raw = body();
    const res = await post(raw, signRequest(raw, CURRENT));
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('applied');
    expect(await receipts()).toEqual([{ auth_status: 'valid', signature_key_id: 'current', raw }]);
  });

  it('accepts the previous key during rotation', async () => {
    const raw = body();
    expect((await post(raw, signRequest(raw, PREVIOUS))).status).toBe(200);
    expect((await receipts())[0].signature_key_id).toBe('previous');
  });

  it.each([
    ['no signature headers', (raw: string) => ({})],
    ['an unknown key', (raw: string) => signRequest(raw, 'whsec_attacker')],
    ['a tampered body', (raw: string) => signRequest(raw.replace('delivered', 'failed'), CURRENT)],
    ['a replayed old timestamp', (raw: string) => signRequest(raw, CURRENT, Date.now() - 10 * 60_000)],
    ['a future timestamp', (raw: string) => signRequest(raw, CURRENT, Date.now() + 10 * 60_000)],
  ])('rejects %s with 401, keeps the raw receipt, and changes nothing', async (_label, sign) => {
    const raw = body();
    const res = await post(raw, sign(raw) as Record<string, string>);
    expect(res.status).toBe(401);
    expect(await receipts()).toEqual([{ auth_status: 'invalid', signature_key_id: null, raw }]);
    expect(await count(pool, 'SELECT count(*) AS n FROM provider_event_applications')).toBe(0);
    expect((await pool.query('SELECT status FROM sends WHERE id = $1', [sendId])).rows[0].status).toBe('planned');
  });

  it('rejects a malformed but correctly signed payload with 400 and a durable receipt', async () => {
    const raw = '{"eventId": "x", "status": "teleported"}';
    const res = await post(raw, signRequest(raw, CURRENT));
    expect(res.status).toBe(400);
    expect(await receipts()).toEqual([{ auth_status: 'valid', signature_key_id: 'current', raw }]);
  });

  it('verifies with constant-time comparison semantics on raw bytes', () => {
    const raw = Buffer.from('{"a":1}');
    const headers = signRequest(raw, CURRENT, 1_800_000_000_000);
    const h = { signature: headers['x-provider-signature'], timestamp: headers['x-provider-timestamp'] };
    expect(verifySignature(raw, h, parseSigningKeys(CURRENT), { nowMs: 1_800_000_000_000 })).toEqual({ ok: true, keyId: 'current' });
    expect(verifySignature(raw, { ...h, signature: 'v1=zz' }, parseSigningKeys(CURRENT), { nowMs: 1_800_000_000_000 })).toMatchObject({ ok: false });
    expect(verifySignature(raw, { ...h, timestamp: 'abc' }, parseSigningKeys(CURRENT), { nowMs: 1_800_000_000_000 })).toEqual({ ok: false, reason: 'bad_timestamp' });
  });
});

describe('event processing', () => {
  const signed = (raw: string) => post(raw, signRequest(raw, CURRENT));

  it('applies a final event that arrives before the worker recorded sent', async () => {
    expect((await signed(body({ status: 'delivered' }))).body.result).toBe('applied');
    expect((await pool.query('SELECT status FROM sends WHERE id = $1', [sendId])).rows[0].status).toBe('delivered');
    // The worker's later "accepted" must not regress it; the webhook-side stale sent is ignored too.
    expect((await signed(body({ status: 'sent' }))).body).toMatchObject({ result: 'ignored', reason: 'stale' });
  });

  it('flags an eventId reused with a different payload but keeps the original', async () => {
    await signed(body({ eventId: 'reused', status: 'sent' })).expect(200);
    const res = await signed(body({ eventId: 'reused', status: 'failed' }));
    expect(res.body).toMatchObject({ result: 'duplicate', conflict: true });
    const same = await signed(body({ eventId: 'reused', status: 'sent' }));
    expect(same.body.result).toBe('duplicate');
    expect(same.body.conflict).toBeUndefined();
    expect((await pool.query('SELECT status FROM sends WHERE id = $1', [sendId])).rows[0].status).toBe('sent');
  });

  it('writes the status outbox row in the same transaction and fans out after commit', async () => {
    const res = await signed(body({ status: 'sent' }));
    const { rows } = await pool.query(`SELECT status, status_version, published_at IS NOT NULL AS published FROM status_event_outbox`);
    expect(rows).toEqual([{ status: 'sent', status_version: 2, published: true }]);
    expect(published).toEqual([expect.objectContaining({ sendId, status: 'sent', statusVersion: res.body.statusVersion })]);
  });

  it('rolls the outbox row back with a failed transaction and retries cleanly', async () => {
    const failing = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        const original = client.query.bind(client) as (...a: unknown[]) => unknown;
        const c = client as any;
        c.query = (text: unknown, ...rest: unknown[]) =>
          typeof text === 'string' && text.includes('INSERT INTO status_event_outbox')
            ? Promise.reject(Object.assign(new Error('connection reset'), { code: '08006' }))
            : original(text, ...rest);
        const release = client.release;
        c.release = (err?: Error) => {
          delete c.query;
          c.release = release;
          return release(err);
        };
        return client;
      },
    } as unknown as Pool;
    const flaky = createApp({ pool: failing, webhook: { signingKeys: parseSigningKeys(CURRENT) } });
    const raw = body({ eventId: 'tx-1', status: 'sent' });
    const res = await request(flaky).post('/v1/webhooks/provider').set({ 'content-type': 'application/json', ...signRequest(raw, CURRENT) }).send(raw);
    expect(res.status).toBe(503);
    expect(await count(pool, 'SELECT count(*) AS n FROM status_event_outbox')).toBe(0);
    expect(await count(pool, 'SELECT count(*) AS n FROM provider_event_applications')).toBe(0);
    expect((await pool.query('SELECT status FROM sends WHERE id = $1', [sendId])).rows[0].status).toBe('planned');
    expect((await signed(raw)).body.result).toBe('applied');
  });

  it('answers unknown sends and duplicates with 2xx so the provider stops retrying', async () => {
    expect((await signed(body({ sendId: 99_999_999 }))).body).toMatchObject({ result: 'ignored', reason: 'unknown_send' });
    const raw = body({ eventId: 'dup' });
    await signed(raw).expect(200);
    expect((await signed(raw)).status).toBe(200);
  });
});

describe('status outbox relay', () => {
  it('is idempotent per (send, statusVersion) and republishes after a crash before marking', async () => {
    await pool.query(`UPDATE sends SET status = 'sent' WHERE id = $1`, [sendId]);
    const change = { campaignId: 1, sendId, branchId: 1, status: 'sent', scheduledAt: null, updatedAt: new Date().toISOString(), statusVersion: 2 };
    for (let i = 0; i < 2; i++) {
      await pool.query(
        `INSERT INTO status_event_outbox (campaign_id, send_id, branch_id, status, status_version, payload)
         VALUES (1, $1, 1, 'sent', 2, $2) ON CONFLICT (send_id, status_version) DO NOTHING`,
        [sendId, JSON.stringify(change)],
      );
    }
    expect(await count(pool, 'SELECT count(*) AS n FROM status_event_outbox')).toBe(1);

    const seen: SendStatusChanged[] = [];
    // A relay that publishes and then dies before marking published.
    let crash = true;
    const crashing = new StatusEventRelay(pool, { publish: (u) => { seen.push(u); if (crash) throw new Error('killed'); } }, { leaseMs: 50 });
    expect(await crashing.runOnce()).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    crash = false;
    expect(await crashing.drain()).toBe(1);
    expect(seen.map((u) => u.statusVersion)).toEqual([2, 2]); // at-least-once; clients keep the highest version
    expect(await count(pool, 'SELECT count(*) AS n FROM status_event_outbox WHERE published_at IS NULL')).toBe(0);
  });
});

describe('webhook rate limiting', () => {
  it('returns 429 with Retry-After before touching the database', async () => {
    const limited = createApp({ pool, webhook: { rateLimit: { ratePerSecond: 1, burst: 2 } } });
    const raw = body();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(limited).post('/v1/webhooks/provider').set('content-type', 'application/json').send(raw);
      statuses.push(res.status);
      if (res.status === 429) expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
    expect(await count(pool, 'SELECT count(*) AS n FROM provider_event_receipts')).toBe(2);
  });
});
