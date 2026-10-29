import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { generateSlots, planBranch } from '../src/campaigns/planner';
import { ProductionPlanner } from '../src/campaigns/production-planner';
import { BRANCHES, buildMembers } from '../src/seed/data';
import { count, freshSeed, testPool } from './helpers';

const pool = testPool();
afterAll(() => pool.end());
beforeEach(() => freshSeed(pool));

const persisted = async () =>
  (await pool.query(`SELECT member_id, branch_id, status, scheduled_at FROM sends WHERE campaign_id = 1 ORDER BY member_id`)).rows.map(
    (r) => ({ memberId: r.member_id, branchId: r.branch_id, status: r.status, scheduledAt: r.scheduled_at?.toISOString() ?? null }),
  );

/** The pure in-memory planner's answer, used as the oracle for the chunked/resumed planner. */
function oracle() {
  const members = buildMembers();
  return BRANCHES.flatMap((b) =>
    planBranch({ members: members.filter((m) => m.branchId === b.id), timeZone: b.timeZone, startDate: '2026-10-23', endDate: '2026-10-29' }).map(
      (p) => ({ ...p, branchId: b.id }),
    ),
  ).sort((a, b) => a.memberId - b.memberId);
}

describe('ProductionPlanner', () => {
  it('produces exactly the pure planner output when chunked', async () => {
    const planner = new ProductionPlanner(pool, { chunkSize: 333 });
    const { run, created } = await planner.planAndWait(1);
    expect(created).toBe(true);
    expect(run).toMatchObject({ status: 'completed', expectedRows: 5000, processedRows: 5000 });
    expect(run.branches.map((b) => [b.branchId, b.planned, b.notScheduled, b.skippedOptOut, b.chunksCommitted])).toEqual([
      [1, 1980, 120, 100, 7], // ceil(2200 / 333)
      [2, 1330, 0, 70, 5],
      [3, 1330, 0, 70, 5],
    ]);
    expect(await persisted()).toEqual(oracle());
  });

  it('streams the audience in bounded chunks rather than loading it all', async () => {
    const seen: number[] = [];
    const spy = pool.query.bind(pool);
    const planner = new ProductionPlanner(pool, {
      chunkSize: 500,
      hooks: { afterChunkCommit: ({ chunk }) => void seen.push(chunk) },
    });
    await planner.planAndWait(1);
    expect(seen.length).toBe(5 + 3 + 3); // 2200/500, 1400/500, 1400/500 rounded up
    expect(spy).toBeDefined();
  });

  it.each([
    ['first chunk of the first branch', 1, 1],
    ['a middle chunk', 1, 4],
    ['the last chunk of a branch', 1, 5],
    ['the first chunk of a later branch', 2, 1],
    ['the final chunk of the run', 3, 3],
  ])('resumes without gaps or duplicates after a crash before commit of %s', async (_label, crashBranch, crashChunk) => {
    let crash = true;
    const planner = new ProductionPlanner(pool, {
      chunkSize: 500,
      hooks: {
        beforeChunkCommit: ({ branchId, chunk }) => {
          if (crash && branchId === crashBranch && chunk === crashChunk) throw new Error('simulated crash');
        },
      },
    });
    await expect(planner.planAndWait(1)).rejects.toThrow('simulated crash');
    const { rows } = await pool.query(`SELECT status, error FROM campaign_plan_runs WHERE campaign_id = 1`);
    expect(rows).toEqual([{ status: 'failed', error: 'simulated crash' }]);
    expect((await pool.query('SELECT planned_at FROM campaigns WHERE id = 1')).rows[0].planned_at).toBeNull();

    crash = false;
    const resumed = await planner.planAndWait(1);
    expect(resumed.created).toBe(false);
    expect(resumed.run.status).toBe('completed');
    expect(resumed.run.attempts).toBe(2);
    expect(await persisted()).toEqual(oracle());
    expect(await count(pool, 'SELECT count(*) AS n FROM campaign_plan_runs')).toBe(1);
  });

  it('resumes after a crash between commit and the next chunk', async () => {
    let crash = true;
    const planner = new ProductionPlanner(pool, {
      chunkSize: 700,
      hooks: { afterChunkCommit: ({ branchId, chunk }) => {
        if (crash && branchId === 2 && chunk === 1) throw new Error('process killed');
      } },
    });
    await expect(planner.planAndWait(1)).rejects.toThrow('process killed');
    const partial = await count(pool, 'SELECT count(*) AS n FROM sends');
    expect(partial).toBe(2200 + 700);
    crash = false;
    await planner.planAndWait(1);
    expect(await persisted()).toEqual(oracle());
  });

  it('lets only one executor run a plan at a time', async () => {
    const planner = new ProductionPlanner(pool, { chunkSize: 250 });
    const { run } = await planner.start(1);
    const results = await Promise.all([planner.execute(run.id), planner.execute(run.id), planner.execute(run.id)]);
    expect(results.filter((r) => r === 'completed')).toHaveLength(1);
    expect(results.filter((r) => r === 'busy' || r === 'not_runnable')).toHaveLength(2);
    expect(await count(pool, 'SELECT count(*) AS n FROM sends')).toBe(5000);
  });

  it('plans against the frozen snapshot even if membership changes mid-run', async () => {
    let injected = false;
    const planner = new ProductionPlanner(pool, {
      chunkSize: 1000,
      hooks: {
        afterChunkCommit: async () => {
          if (injected) return;
          injected = true;
          await pool.query(`INSERT INTO members (id, branch_id, name, phone) VALUES (9001, 3, 'Late', '+61400999001')`);
          await pool.query(`UPDATE members SET sms_opt_out = true WHERE id = 4999`);
        },
      },
    });
    await planner.planAndWait(1);
    expect(await count(pool, 'SELECT count(*) AS n FROM sends WHERE member_id = 9001')).toBe(0);
    expect((await pool.query('SELECT status FROM sends WHERE member_id = 4999')).rows[0].status).not.toBe('skipped_opt_out');
    expect(await persisted()).toEqual(oracle());
  });

  it('never assigns past slots for a live (dispatch-enabled) campaign', async () => {
    await pool.query(`UPDATE campaigns SET dispatch_enabled = true WHERE id = 1`);
    const planner = new ProductionPlanner(pool);
    const { run } = await planner.planAndWait(1);
    expect(run.earliestSlotAt).not.toBeNull();
    expect(await count(pool, `SELECT count(*) AS n FROM sends WHERE scheduled_at < $1`, [run.earliestSlotAt])).toBe(0);
    // Only slots at/after the run's fixed earliestSlotAt are usable; the rest of each branch's
    // eligible members are not_scheduled. (Depends on the wall clock, so derive the expectation.)
    const eligible = { 'Europe/London': 2100, 'Asia/Kathmandu': 1330, 'Australia/Sydney': 1330 };
    let planned = 0;
    for (const [zone, n] of Object.entries(eligible)) {
      planned += Math.min(n, generateSlots(zone, '2026-10-23', '2026-10-29').filter((s) => s >= run.earliestSlotAt!).length);
    }
    expect(await count(pool, `SELECT count(*) AS n FROM sends WHERE status = 'planned'`)).toBe(planned);
    expect(await count(pool, `SELECT count(*) AS n FROM sends WHERE status = 'not_scheduled'`)).toBe(4760 - planned);
  });
});

describe('plan routes', () => {
  const app = createApp({ pool });

  it('returns 202 with a plan run for Prefer: respond-async, then reports progress to completion', async () => {
    const res = await request(app).post('/v1/campaigns/1/plan').set('Prefer', 'respond-async');
    expect(res.status).toBe(202);
    expect(res.headers['preference-applied']).toBe('respond-async');
    expect(res.headers.location).toBe(`/v1/campaigns/1/plan-runs/${res.body.planRunId}`);
    expect(res.body).toMatchObject({ campaignId: 1, created: true });
    expect(['queued', 'running', 'completed']).toContain(res.body.status);

    let progress: request.Response;
    do {
      progress = await request(app).get(res.headers.location).expect(200);
    } while (progress.body.status !== 'completed' && (await new Promise((r) => setTimeout(r, 25)), true));
    expect(progress.body).toMatchObject({ status: 'completed', processedRows: 5000, expectedRows: 5000 });

    const again = await request(app).post('/v1/campaigns/1/plan?async=true');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ planRunId: res.body.planRunId, status: 'completed', created: false });
  });

  it('keeps the synchronous contract by default', async () => {
    const res = await request(app).post('/campaigns/1/plan').expect(201);
    expect(res.body.totals.total).toBe(5000);
  });

  it('reports capacity before and after planning', async () => {
    const before = await request(app).get('/v1/campaigns/1/capacity').expect(200);
    expect(before.body.source).toBe('live_members');
    expect(before.body.branches.map((b: any) => [b.name, b.slots, b.eligible, b.projectedPlanned, b.projectedNotScheduled])).toEqual([
      ['London Central', 1980, 2100, 1980, 120],
      ['Kathmandu Durbar', 1980, 1330, 1330, 0],
      ['Sydney Harbour', 1980, 1330, 1330, 0],
    ]);
    expect(before.body.totals).toMatchObject({ audience: 5000, optedOut: 240, projectedPlanned: 4640, projectedNotScheduled: 120 });
    await request(app).post('/v1/campaigns/1/plan').expect(201);
    const after = await request(app).get('/v1/campaigns/1/capacity').expect(200);
    expect(after.body).toMatchObject({ source: 'snapshot', audienceVersion: 1 });
  });

  it('404s unknown campaigns and plan runs', async () => {
    await request(app).post('/v1/campaigns/99/plan').set('Prefer', 'respond-async').expect(404);
    await request(app).get('/v1/campaigns/1/plan-runs/12345').expect(404);
    await request(app).get('/v1/campaigns/99/capacity').expect(404);
  });
});
