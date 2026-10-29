import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../src/app';
import { SseHub } from '../src/live/sse-hub';
import { freshSeed, testPool } from './helpers';

const pool = testPool();
const hub = new SseHub(60_000);
const app = createApp({ pool, hub });

beforeAll(async () => {
  await freshSeed(pool);
  await request(app).post('/v1/campaigns/1/plan').expect(201);
});
afterAll(async () => {
  hub.close();
  await pool.end();
});

const webhook = (path: string, eventId: string, sendId: number) =>
  request(app)
    .post(path)
    .set('content-type', 'application/json')
    .send(JSON.stringify({ eventId, sendId, status: 'sent', occurredAt: '2026-10-23T08:00:05Z' }));

describe('API versioning', () => {
  it('serves every resource under /v1 and labels the response', async () => {
    const summary = await request(app).get('/v1/campaigns/1/summary').expect(200);
    expect(summary.headers['api-version']).toBe('v1');
    expect(summary.body.totals.total).toBe(5000);

    const sends = await request(app).get('/v1/campaigns/1/sends').query({ branchId: 2, limit: 5 }).expect(200);
    expect(sends.headers['api-version']).toBe('v1');
    expect(sends.body.items).toHaveLength(5);

    const plan = await request(app).post('/v1/campaigns/1/plan').expect(200);
    expect(plan.body.created).toBe(false);
  });

  it('keeps the required unversioned paths as an alias of v1 with identical bodies', async () => {
    for (const path of ['/campaigns/1/summary', '/campaigns/1/sends?limit=50&status=planned']) {
      const [unversioned, v1] = await Promise.all([request(app).get(path), request(app).get(`/v1${path}`)]);
      expect(unversioned.status).toBe(200);
      expect(unversioned.headers['api-version']).toBe('v1');
      expect(unversioned.body).toEqual(v1.body);
    }
    await request(app).post('/campaigns/1/plan').expect(200);
  });

  it('accepts provider webhooks on both paths and dedupes across them', async () => {
    const { rows } = await pool.query(`SELECT id FROM sends WHERE status = 'planned' ORDER BY id LIMIT 1`);
    const first = await webhook('/v1/webhooks/provider', 'ver-1', rows[0].id).expect(200);
    expect(first.body.result).toBe('applied');
    expect(first.headers['api-version']).toBe('v1');
    // Same eventId arriving on the legacy URL is still the same event.
    const again = await webhook('/webhooks/provider', 'ver-1', rows[0].id).expect(200);
    expect(again.body.result).toBe('duplicate');
  });

  it('keeps validation and not-found behaviour inside a version', async () => {
    await request(app).get('/v1/campaigns/1/sends').query({ limit: 5000 }).expect(400);
    await request(app).get('/v1/campaigns/999/summary').expect(404);
    const missing = await request(app).get('/v1/nope').expect(404);
    expect(missing.body.error).toBe('not_found');
  });

  it('rejects unknown versions with the supported list, without touching the database', async () => {
    for (const path of ['/v2/campaigns/1/summary', '/v0/webhooks/provider', '/v99']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.body).toMatchObject({ error: 'unsupported_api_version', supportedVersions: ['v1'] });
    }
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM webhook_receipts WHERE convert_from(raw_body, 'UTF8') LIKE '%v2-event%'`);
    await webhook('/v2/webhooks/provider', 'v2-event', 1).expect(404);
    const after = await pool.query(`SELECT count(*)::int AS n FROM webhook_receipts WHERE convert_from(raw_body, 'UTF8') LIKE '%v2-event%'`);
    expect(after.rows[0].n).toBe(rows[0].n);
  });

  it('streams SSE under /v1', async () => {
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/campaigns/1/events`, {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('api-version')).toBe('v1');
      const { value } = await res.body!.getReader().read();
      expect(new TextDecoder().decode(value)).toContain('event: ready');
    } finally {
      controller.abort();
      await new Promise((r) => server.close(r));
    }
  });

  it('leaves /health unversioned', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.headers['api-version']).toBeUndefined();
  });
});
