import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { CampaignRepository } from '../src/campaigns/repository';
import { BRANCHES, buildMembers, isSpreadOptOut } from '../src/seed/data';
import { seed } from '../src/seed/seed';
import { count, freshSeed, testPool } from './helpers';

const pool = testPool();
beforeAll(() => freshSeed(pool));
afterAll(() => pool.end());

describe('seed data', () => {
  it('builds 5,000 unique members in fixed branch ranges', () => {
    const members = buildMembers();
    expect(members).toHaveLength(5000);
    expect(new Set(members.map((m) => m.id)).size).toBe(5000);
    expect(new Set(members.map((m) => m.phone)).size).toBe(5000);
    expect(new Set(members.map((m) => m.name)).size).toBe(5000);
    const range = (branchId: number) => {
      const ids = members.filter((m) => m.branchId === branchId).map((m) => m.id);
      return [Math.min(...ids), Math.max(...ids), ids.length];
    };
    expect(range(1)).toEqual([1, 2200, 2200]);
    expect(range(2)).toEqual([2201, 3600, 1400]);
    expect(range(3)).toEqual([3601, 5000, 1400]);
  });

  it('spreads exactly the requested opt-outs through each branch range', () => {
    const members = buildMembers();
    for (const branch of BRANCHES) {
      const inBranch = members.filter((m) => m.branchId === branch.id);
      const optedOut = inBranch.filter((m) => m.smsOptOut);
      expect(optedOut).toHaveLength(branch.optOutCount);
      // Spread: every slice of 1/5 of the branch contains roughly 1/5 of its opt-outs.
      const fifth = inBranch.length / 5;
      for (let k = 0; k < 5; k++) {
        const slice = inBranch.slice(k * fifth, (k + 1) * fifth).filter((m) => m.smsOptOut).length;
        expect(slice).toBe(branch.optOutCount / 5);
      }
    }
    expect(members.filter((m) => m.smsOptOut)).toHaveLength(240);
    expect([...Array(22).keys()].filter((i) => isSpreadOptOut(i, 2200, 100))).toEqual([21]);
  });
});

describe('seed persistence', () => {
  it('stores the exact branches, members, and opt-outs', async () => {
    const { rows } = await pool.query(
      `SELECT b.id, b.name, b.time_zone, count(m.id) AS members, count(*) FILTER (WHERE m.sms_opt_out) AS opted_out
         FROM branches b JOIN members m ON m.branch_id = b.id GROUP BY b.id ORDER BY b.id`,
    );
    expect(rows).toEqual([
      { id: 1, name: 'London Central', time_zone: 'Europe/London', members: 2200, opted_out: 100 },
      { id: 2, name: 'Kathmandu Durbar', time_zone: 'Asia/Kathmandu', members: 1400, opted_out: 70 },
      { id: 3, name: 'Sydney Harbour', time_zone: 'Australia/Sydney', members: 1400, opted_out: 70 },
    ]);
  });

  it('stores campaign 1 with its date range and three branch links', async () => {
    const { rows } = await pool.query('SELECT id, name, start_date, end_date, planned_at FROM campaigns');
    expect(rows).toEqual([
      { id: 1, name: 'Win-back October', start_date: '2026-10-23', end_date: '2026-10-29', planned_at: null },
    ]);
    const { rows: links } = await pool.query('SELECT branch_id FROM campaign_branches WHERE campaign_id = 1 ORDER BY 1');
    expect(links.map((l) => l.branch_id)).toEqual([1, 2, 3]);
  });

  it('can be re-run after planning without touching sends', async () => {
    await new CampaignRepository(pool).plan(1);
    const before = await pool.query('SELECT id, member_id, status, scheduled_at, status_version FROM sends ORDER BY id');
    const plannedAt = (await pool.query('SELECT planned_at FROM campaigns WHERE id = 1')).rows[0].planned_at;

    await seed(pool);
    await seed(pool);

    const after = await pool.query('SELECT id, member_id, status, scheduled_at, status_version FROM sends ORDER BY id');
    expect(after.rows).toEqual(before.rows);
    expect((await pool.query('SELECT planned_at FROM campaigns WHERE id = 1')).rows[0].planned_at).toEqual(plannedAt);
    expect(await count(pool, 'SELECT count(*) AS n FROM members')).toBe(5000);
    expect(await count(pool, 'SELECT count(*) AS n FROM branches')).toBe(3);
  });

  it('has campaign 1 ready by the time the app serves requests', async () => {
    // server.ts runs migrate() then seed() before listen(); the app sees the seeded campaign.
    const res = await request(createApp({ pool })).get('/campaigns/1/summary');
    expect(res.status).toBe(200);
    expect(res.body.campaign.name).toBe('Win-back October');
  });
});
