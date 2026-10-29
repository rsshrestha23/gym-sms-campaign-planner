import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { CampaignRepository } from '../src/campaigns/repository';
import { generateBatch } from '../src/simulator/events';
import { dispatchEvents, fetchPlannedSends, PlannedSendRef } from '../src/simulator/provider-client';
import { parseArgs, simulate } from '../src/simulator/simulate';
import { count, freshSeed, testPool } from './helpers';

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const fakeSends = (n: number): PlannedSendRef[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, scheduledAt: new Date(Date.UTC(2026, 9, 23, 8, i * 2)).toISOString() }));

describe('generateBatch', () => {
  const batch = generateBatch(fakeSends(4640));

  it('creates one sent and one final event per planned send with exact 85/10/5 outcomes', () => {
    expect(batch.events).toHaveLength(9280);
    expect(new Set(batch.events.map((e) => e.eventId)).size).toBe(9280);
    expect(batch.events.filter((e) => e.status === 'sent')).toHaveLength(4640);
    expect(batch.outcomes).toEqual({ delivered: 3944, undelivered: 464, failed: 232 });
    for (const status of ['delivered', 'undelivered', 'failed'] as const) {
      expect(batch.events.filter((e) => e.status === status)).toHaveLength(batch.outcomes[status]);
    }
    for (const e of batch.events) expect(e.occurredAt).toMatch(/Z$/);
  });

  it('repeats each event 1–3 times reusing its eventId, then shuffles all copies', () => {
    const copies = new Map<string, number>();
    for (const r of batch.requests) copies.set(r.eventId, (copies.get(r.eventId) ?? 0) + 1);
    expect(copies.size).toBe(9280);
    const distribution = new Set(copies.values());
    expect([...distribution].sort()).toEqual([1, 2, 3]);
    expect(batch.requests.length).toBeGreaterThanOrEqual(9280);
    expect(batch.requests.length).toBeLessThanOrEqual(27840);
    // Shuffled: copies of one event are not all adjacent and sent/final are interleaved.
    const firstHundred = batch.requests.slice(0, 100).map((r) => r.sendId);
    expect(firstHundred).not.toEqual([...firstHundred].sort((a, b) => a - b));
  });

  it('is reproducible for a fixed seed and differs for another seed', () => {
    expect(generateBatch(fakeSends(500))).toEqual(generateBatch(fakeSends(500)));
    expect(generateBatch(fakeSends(500), 7).requests).not.toEqual(generateBatch(fakeSends(500)).requests);
  });
});

describe('fetchPlannedSends', () => {
  it('follows cursors using only the HTTP API', async () => {
    const seen: string[] = [];
    const all = fakeSends(25);
    const { server, url } = await listen((req, res) => {
      seen.push(req.url!);
      const u = new URL(req.url!, 'http://x');
      const cursor = Number(u.searchParams.get('cursor') ?? 0);
      const limit = Number(u.searchParams.get('limit'));
      const items = all.filter((s) => s.id > cursor).slice(0, limit);
      const next = items.length === limit && items[items.length - 1].id < 25 ? String(items[items.length - 1].id) : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items, nextCursor: next }));
    });
    try {
      const sends = await fetchPlannedSends(url, 1, { pageSize: 10 });
      expect(sends.map((s) => s.id)).toEqual(all.map((s) => s.id));
      expect(seen).toEqual([
        '/v1/campaigns/1/sends?status=planned&limit=10',
        '/v1/campaigns/1/sends?status=planned&limit=10&cursor=10',
        '/v1/campaigns/1/sends?status=planned&limit=10&cursor=20',
      ]);
    } finally {
      server.close();
    }
  });
});

describe('dispatchEvents', () => {
  it('keeps exactly 50 requests in flight against a slow server', async () => {
    let inFlight = 0;
    let peak = 0;
    const { server, url } = await listen((req, res) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      req.resume();
      setTimeout(() => {
        inFlight--;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ result: 'applied' }));
      }, 40);
    });
    try {
      const { requests } = generateBatch(fakeSends(100));
      const report = await dispatchEvents(url, requests);
      expect(peak).toBe(50);
      expect(report.maxInFlight).toBe(50);
      expect(report.attempted).toBe(requests.length);
      expect(report.applied).toBe(requests.length);
    } finally {
      server.close();
    }
  });

  it('caps request starts per second with --rate', async () => {
    const starts: number[] = [];
    const { server, url } = await listen((req, res) => {
      starts.push(Date.now());
      req.resume();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: 'duplicate' }));
    });
    try {
      const { requests } = generateBatch(fakeSends(10));
      const subset = requests.slice(0, 21);
      const report = await dispatchEvents(url, subset, { ratePerSecond: 100 });
      expect(report.duplicate).toBe(21);
      expect(starts[starts.length - 1] - starts[0]).toBeGreaterThanOrEqual(180);
      expect(report.elapsedMs).toBeGreaterThanOrEqual(190);
    } finally {
      server.close();
    }
  });

  it('counts 4xx as rejected and 5xx/network failures as errors once retries run out', async () => {
    let n = 0;
    const { server, url } = await listen((req, res) => {
      req.resume();
      res.statusCode = n++ % 2 ? 400 : 503;
      res.end('{}');
    });
    try {
      const report = await dispatchEvents(url, generateBatch(fakeSends(2)).events, { concurrency: 1, retries: 0 });
      expect(report).toMatchObject({ attempted: 4, rejected: 2, error: 2 });
    } finally {
      server.close();
    }
  });

  it('retries 429/503 like a provider, honouring Retry-After, and signs every request', async () => {
    const seen: { sig?: string; ts?: string }[] = [];
    let n = 0;
    const { server, url } = await listen((req, res) => {
      seen.push({ sig: req.headers['x-provider-signature'] as string, ts: req.headers['x-provider-timestamp'] as string });
      req.resume();
      const call = n++;
      if (call === 0) {
        res.writeHead(429, { 'retry-after': '1' });
        return res.end('{}');
      }
      if (call === 1) {
        res.statusCode = 503;
        return res.end('{}');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: 'applied' }));
    });
    try {
      const started = Date.now();
      const report = await dispatchEvents(url, generateBatch(fakeSends(1)).events.slice(0, 1), { concurrency: 1, signingSecret: 's3cret' });
      expect(report).toMatchObject({ attempted: 1, applied: 1, retried: 2, error: 0 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
      expect(seen.every((h) => /^v1=[0-9a-f]{64}$/.test(h.sig ?? '') && /^\d+$/.test(h.ts ?? ''))).toBe(true);
    } finally {
      server.close();
    }
  });

  it('parses CLI flags', () => {
    expect(parseArgs(['--rate', '25'], { API_BASE_URL: 'http://api:3000' })).toMatchObject({
      baseUrl: 'http://api:3000', ratePerSecond: 25, concurrency: 50, campaignId: 1, signingSecret: 'dev-only-webhook-secret',
    });
    expect(parseArgs([], { WEBHOOK_SIGNING_SECRET: 'other' }).signingSecret).toBe('other');
    expect(parseArgs(['--rate=10', '--concurrency=5'], {})).toMatchObject({ ratePerSecond: 10, concurrency: 5 });
    expect(() => parseArgs(['--rate', '0'], {})).toThrow();
    expect(() => parseArgs(['--nope'], {})).toThrow();
  });
});

describe('simulate end to end', () => {
  const pool = testPool(60);
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    await freshSeed(pool);
    await new CampaignRepository(pool).plan(1);
    ({ server, url } = await listen(createApp({ pool })));
  });
  afterAll(async () => {
    server.close();
    await pool.end();
  });

  it('delivers the generated outcomes exactly once through the webhook', async () => {
    const { sends, batch, report } = await simulate(
      { baseUrl: url, campaignId: 1, concurrency: 50, seed: 20261029 },
      () => undefined,
    );
    expect(sends).toHaveLength(4640);
    expect(batch.events).toHaveLength(9280);
    expect(report.error + report.rejected).toBe(0);
    expect(report.attempted).toBe(batch.requests.length);
    expect(report.applied + report.ignored).toBe(9280);
    expect(report.duplicate).toBe(batch.requests.length - 9280);

    expect(await count(pool, 'SELECT count(*) AS n FROM provider_event_receipts')).toBe(batch.requests.length);
    expect(await count(pool, 'SELECT count(*) AS n FROM provider_event_applications')).toBe(9280);
    const { rows } = await pool.query(`SELECT status, count(*)::int AS n FROM sends GROUP BY status ORDER BY status`);
    expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toEqual({
      delivered: 3944, undelivered: 464, failed: 232, not_scheduled: 120, skipped_opt_out: 240,
    });

    // A second run reuses event IDs: every request is a duplicate and nothing changes.
    const again = await simulate({ baseUrl: url, campaignId: 1, concurrency: 50, seed: 20261029 }, () => undefined);
    expect(again.sends).toHaveLength(0); // nothing is still `planned`
  }, 120_000);
});
