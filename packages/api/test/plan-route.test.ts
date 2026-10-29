import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { count, freshSeed, testPool } from './helpers';

const pool = testPool();
const app = createApp({ pool });
beforeEach(() => freshSeed(pool));
afterAll(() => pool.end());

const snapshot = () =>
  pool.query('SELECT id, member_id, branch_id, status, scheduled_at FROM sends ORDER BY member_id').then((r) => r.rows);

describe('POST /campaigns/:id/plan', () => {
  it('creates one send per member with per-branch counts', async () => {
    const res = await request(app).post('/campaigns/1/plan');
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.campaign.plannedAt).toMatch(/Z$/);
    expect(
      res.body.branches.map((b: any) => [b.name, b.counts.planned, b.counts.not_scheduled, b.counts.skipped_opt_out, b.total]),
    ).toEqual([
      ['London Central', 1980, 120, 100, 2200],
      ['Kathmandu Durbar', 1330, 0, 70, 1400],
      ['Sydney Harbour', 1330, 0, 70, 1400],
    ]);
    expect(res.body.totals.total).toBe(5000);
    expect(await count(pool, 'SELECT count(*) AS n FROM sends')).toBe(5000);
    // Planning only persists a schedule; nothing is sent.
    expect(await count(pool, `SELECT count(*) AS n FROM sends WHERE status NOT IN ('planned','not_scheduled','skipped_opt_out')`)).toBe(0);
  });

  it('returns the identical persisted plan on repeat calls', async () => {
    await request(app).post('/campaigns/1/plan').expect(201);
    const first = await snapshot();
    const again = await request(app).post('/campaigns/1/plan');
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(await snapshot()).toEqual(first);
  });

  it('creates exactly one plan under concurrent requests', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(app).post('/campaigns/1/plan')));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(await count(pool, 'SELECT count(*) AS n FROM sends')).toBe(5000);
    expect(await count(pool, 'SELECT count(DISTINCT member_id) AS n FROM sends')).toBe(5000);
    expect(await count(pool, 'SELECT count(DISTINCT (branch_id, scheduled_at)) AS n FROM sends WHERE scheduled_at IS NOT NULL')).toBe(4640);
    expect(await count(pool, 'SELECT count(*) AS n FROM sends WHERE scheduled_at IS NOT NULL')).toBe(4640);
  });

  it('keeps the plan immutable when membership changes after planning', async () => {
    await request(app).post('/campaigns/1/plan').expect(201);
    const before = await snapshot();
    await pool.query(`INSERT INTO members (id, branch_id, name, phone) VALUES (9001, 2, 'Late Joiner', '+97700009001')`);
    const res = await request(app).post('/campaigns/1/plan');
    expect(res.status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it('is deterministic across reset and replan', async () => {
    await request(app).post('/campaigns/1/plan').expect(201);
    const first = (await snapshot()).map(({ id, ...rest }) => rest);
    await freshSeed(pool);
    await request(app).post('/campaigns/1/plan').expect(201);
    expect((await snapshot()).map(({ id, ...rest }) => rest)).toEqual(first);
  });

  it('returns 404 for an unknown campaign and 400 for a bad id', async () => {
    await request(app).post('/campaigns/999/plan').expect(404);
    await request(app).post('/campaigns/abc/plan').expect(400);
  });
});
