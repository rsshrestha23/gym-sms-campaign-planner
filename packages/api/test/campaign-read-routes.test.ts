import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { freshSeed, testPool } from './helpers';

const pool = testPool();
const app = createApp({ pool });
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterAll(() => pool.end());

describe('before planning', () => {
  beforeAll(() => freshSeed(pool));

  it('summarizes zero counts and empty schedules', async () => {
    const res = await request(app).get('/campaigns/1/summary').expect(200);
    expect(res.body.campaign).toEqual({
      id: 1, name: 'Win-back October', startDate: '2026-10-23', endDate: '2026-10-29', plannedAt: null,
    });
    expect(res.body.totals.total).toBe(0);
    for (const b of res.body.branches) {
      expect(b.total).toBe(0);
      expect(Object.values(b.counts).every((n) => n === 0)).toBe(true);
      expect(b.earliestScheduledAt).toBeNull();
      expect(b.latestScheduledAt).toBeNull();
    }
    const sends = await request(app).get('/campaigns/1/sends').expect(200);
    expect(sends.body).toEqual({ items: [], nextCursor: null });
  });
});

describe('after planning', () => {
  beforeAll(async () => {
    await freshSeed(pool);
    await request(app).post('/campaigns/1/plan').expect(201);
    // Give a few sends provider statuses to exercise the filters.
    const { rows } = await pool.query(`SELECT id FROM sends WHERE branch_id = 3 AND status = 'planned' ORDER BY id LIMIT 3`);
    await pool.query(`UPDATE sends SET status = 'sent' WHERE id = $1`, [rows[0].id]);
    await pool.query(`UPDATE sends SET status = 'delivered' WHERE id = ANY($1)`, [[rows[1].id, rows[2].id]]);
  });

  it('returns every status per branch including zeroes, plus UTC first/last slots', async () => {
    const res = await request(app).get('/campaigns/1/summary').expect(200);
    const [london, kathmandu, sydney] = res.body.branches;
    expect(london).toMatchObject({
      id: 1, name: 'London Central', timeZone: 'Europe/London', total: 2200,
      counts: { planned: 1980, sent: 0, delivered: 0, undelivered: 0, failed: 0, skipped_opt_out: 100, not_scheduled: 120 },
      earliestScheduledAt: '2026-10-23T08:00:00.000Z',
      latestScheduledAt: '2026-10-29T19:58:00.000Z',
    });
    expect(kathmandu).toMatchObject({
      timeZone: 'Asia/Kathmandu',
      counts: { planned: 1330, not_scheduled: 0, skipped_opt_out: 70 },
      earliestScheduledAt: '2026-10-23T03:15:00.000Z',
    });
    // Kathmandu's 1,330th slot: 4 full days (1,320) + 10 slots on Wed 28th -> 09:18 local = 03:33Z.
    expect(kathmandu.latestScheduledAt).toBe('2026-10-28T03:33:00.000Z');
    expect(sydney).toMatchObject({
      counts: { planned: 1327, sent: 1, delivered: 2, undelivered: 0, failed: 0, skipped_opt_out: 70, not_scheduled: 0 },
      earliestScheduledAt: '2026-10-22T22:00:00.000Z',
    });
    expect(res.body.totals).toMatchObject({ total: 5000, planned: 4637, sent: 1, delivered: 2 });
  });

  it('pages through all 5,000 sends with a stable cursor', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await request(app)
        .get('/campaigns/1/sends')
        .query({ limit: 1000, ...(cursor ? { cursor } : {}) })
        .expect(200);
      pages++;
      seen.push(...res.body.items.map((i: any) => i.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(pages).toBe(5);
    expect(seen).toHaveLength(5000);
    expect(new Set(seen).size).toBe(5000);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('defaults to 100 rows and serializes the documented fields', async () => {
    const res = await request(app).get('/campaigns/1/sends').expect(200);
    expect(res.body.items).toHaveLength(100);
    expect(res.body.nextCursor).toBe(String(res.body.items[99].id));
    const first = res.body.items[0];
    expect(Object.keys(first).sort()).toEqual(
      ['branchId', 'campaignId', 'id', 'memberId', 'memberName', 'phone', 'scheduledAt', 'status', 'statusVersion', 'updatedAt'].sort(),
    );
    expect(first).toMatchObject({ memberId: 1, branchId: 1, status: 'planned', scheduledAt: '2026-10-23T08:00:00.000Z', statusVersion: 1 });
    expect(first.updatedAt).toMatch(ISO_UTC);
    const page2 = await request(app).get('/campaigns/1/sends').query({ cursor: res.body.nextCursor }).expect(200);
    expect(page2.body.items[0].id).toBeGreaterThan(res.body.items[99].id);
  });

  it('filters by branch, status, and both', async () => {
    const branch = await request(app).get('/campaigns/1/sends').query({ branchId: 2, limit: 1000 }).expect(200);
    expect(branch.body.items.every((i: any) => i.branchId === 2)).toBe(true);
    expect(branch.body.items).toHaveLength(1000);

    const skipped = await request(app).get('/campaigns/1/sends').query({ status: 'skipped_opt_out', limit: 1000 }).expect(200);
    expect(skipped.body.items).toHaveLength(240);
    expect(skipped.body.items.every((i: any) => i.scheduledAt === null)).toBe(true);
    expect(skipped.body.nextCursor).toBeNull();

    const both = await request(app).get('/campaigns/1/sends').query({ branchId: 1, status: 'not_scheduled', limit: 1000 }).expect(200);
    expect(both.body.items).toHaveLength(120);
    expect(both.body.items[0].memberId).toBeGreaterThan(2000);

    const delivered = await request(app).get('/campaigns/1/sends').query({ branchId: 3, status: 'delivered' }).expect(200);
    expect(delivered.body.items.map((i: any) => i.statusVersion)).toEqual([2, 2]);

    const none = await request(app).get('/campaigns/1/sends').query({ branchId: 2, status: 'not_scheduled' }).expect(200);
    expect(none.body).toEqual({ items: [], nextCursor: null });
  });

  it('validates query parameters and campaign ids', async () => {
    for (const query of [{ limit: 0 }, { limit: 1001 }, { limit: 'x' }, { status: 'bogus' }, { branchId: 'one' }, { cursor: '-1' }]) {
      const res = await request(app).get('/campaigns/1/sends').query(query);
      expect(res.status, JSON.stringify(query)).toBe(400);
    }
    await request(app).get('/campaigns/1/sends').query({ limit: 1000 }).expect(200);
    await request(app).get('/campaigns/42/sends').expect(404);
    await request(app).get('/campaigns/42/summary').expect(404);
  });
});
