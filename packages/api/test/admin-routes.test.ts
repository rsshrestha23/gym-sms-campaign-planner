import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { CampaignRepository } from '../src/campaigns/repository';
import { count, freshSeed, testPool } from './helpers';

const pool = testPool();
afterAll(() => pool.end());

const TOKEN = 'test-admin-token';
let paused = false;
const app = createApp({
  pool,
  adminToken: TOKEN,
  queueControl: {
    pause: async () => void (paused = true),
    resume: async () => void (paused = false),
    counts: async () => ({ waiting: 3, paused: Number(paused) }),
  },
});
const admin = (method: 'get' | 'post', path: string) =>
  request(app)[method](`/v1/admin${path}`).set('authorization', `Bearer ${TOKEN}`);

beforeEach(async () => {
  await freshSeed(pool);
  await new CampaignRepository(pool).plan(1);
});

describe('admin routes', () => {
  it('require the bearer token and are absent without one configured', async () => {
    await request(app).post('/v1/admin/campaigns/1/dispatch/pause').expect(401);
    await request(app).post('/v1/admin/campaigns/1/dispatch/pause').set('authorization', 'Bearer wrong-token-value').expect(401);
    await request(createApp({ pool })).post('/v1/admin/campaigns/1/dispatch/pause').expect(404);
  });

  it('resumes and pauses campaign dispatch', async () => {
    const resumed = await admin('post', '/campaigns/1/dispatch/resume').expect(200);
    expect(resumed.body).toMatchObject({ campaignId: 1, dispatchEnabled: true, pausedAt: null });
    const p = await admin('post', '/campaigns/1/dispatch/pause').expect(200);
    expect(p.body.pausedAt).toMatch(/Z$/);
    await admin('post', '/campaigns/99/dispatch/pause').expect(404);
  });

  it('cancels a campaign, suppressing every unsent send and notifying dashboards', async () => {
    await pool.query(`UPDATE sends SET status = 'delivered' WHERE id = (SELECT min(id) FROM sends WHERE status = 'planned')`);
    const res = await admin('post', '/campaigns/1/cancel').expect(200);
    expect(res.body.cancelledAt).toMatch(/Z$/);
    expect(await count(pool, `SELECT count(*) AS n FROM sends WHERE status = 'planned'`)).toBe(0);
    expect(await count(pool, `SELECT count(*) AS n FROM sends WHERE suppression_reason = 'campaign_cancelled'`)).toBe(4639);
    expect(await count(pool, `SELECT count(*) AS n FROM status_event_outbox`)).toBe(4639);
    expect(await count(pool, `SELECT count(*) AS n FROM sends WHERE status = 'delivered'`)).toBe(1);
    // Resume is refused for a cancelled campaign.
    await admin('post', '/campaigns/1/dispatch/resume').expect(404);
  });

  it('lists dead letters and retries only those still planned, under a new generation', async () => {
    const { rows } = await pool.query(`SELECT id FROM sends WHERE status = 'planned' ORDER BY id LIMIT 2`);
    const [parked, failed] = rows.map((r) => r.id);
    await pool.query(`UPDATE sends SET dispatch_state = 'dead_letter', dispatch_generation = 3 WHERE id = $1`, [parked]);
    await pool.query(`UPDATE sends SET status = 'failed', dispatch_state = 'dead_letter' WHERE id = $1`, [failed]);
    const list = await admin('get', '/campaigns/1/dead-letters').expect(200);
    expect(list.body.items.map((i: any) => [i.sendId, i.status])).toEqual([[parked, 'planned'], [failed, 'failed']]);

    expect((await admin('post', `/sends/${parked}/retry`).expect(200)).body).toEqual({ sendId: parked, dispatchGeneration: 4 });
    await admin('post', `/sends/${failed}/retry`).expect(409);
    const { rows: outbox } = await pool.query(`SELECT send_id, dispatch_generation, job_id FROM send_outbox`);
    expect(outbox).toEqual([{ send_id: parked, dispatch_generation: 4, job_id: `send-${parked}-4` }]);
    expect((await admin('get', `/sends/${parked}/attempts`).expect(200)).body.items).toEqual([]);
  });

  it('replays outbox rows and reconciles counters', async () => {
    await pool.query(
      `INSERT INTO send_outbox (send_id, event_type, dispatch_generation, job_id, payload, published_at)
       SELECT id, 'dispatch', 1, 'send-' || id || '-1', '{}', now() FROM sends WHERE status = 'planned' ORDER BY id LIMIT 3`,
    );
    await admin('post', '/outbox/replay').send({ since: 'nope' }).expect(400);
    const replay = await admin('post', '/outbox/replay').send({ since: new Date(Date.now() - 60_000).toISOString() }).expect(200);
    expect(replay.body).toEqual({ dispatch: 3, status: 0 });
    expect(await count(pool, `SELECT count(*) AS n FROM send_outbox WHERE published_at IS NULL`)).toBe(3);
    expect((await admin('post', '/campaigns/1/status-counts/reconcile').expect(200)).body).toEqual({ drift: [] });
  });

  it('pauses and resumes the queue', async () => {
    expect((await admin('post', '/queue/pause').expect(200)).body).toEqual({ waiting: 3, paused: 1 });
    expect((await admin('post', '/queue/resume').expect(200)).body).toEqual({ waiting: 3, paused: 0 });
  });

  it('exposes Prometheus metrics and split health probes', async () => {
    const metrics = await request(app).get('/metrics').expect(200);
    expect(metrics.text).toContain('gym_webhook_requests_total');
    expect((await request(app).get('/health/live').expect(200)).body).toEqual({ status: 'ok' });
    expect((await request(app).get('/health/ready').expect(200)).body).toEqual({ status: 'ready', checks: { postgres: 'ok' } });
    const failing = createApp({ pool, readinessChecks: [{ name: 'redis', check: () => Promise.reject(new Error('down')) }] });
    expect((await request(failing).get('/health/ready').expect(503)).body.checks).toEqual({ postgres: 'ok', redis: 'down' });
    await request(failing).get('/health/live').expect(200); // liveness ignores dependencies
    const res = await request(app).get('/health').set('x-request-id', 'corr-123');
    expect(res.headers['x-request-id']).toBe('corr-123');
  });
});
