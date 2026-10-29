/**
 * Capacity test: plan a campaign for 100 branches / 5,000,000 members.
 *
 *   npm run load:plan -- [--members 5000000] [--branches 100] [--chunk 50000] [--crash-at 37]
 *
 * Uses a separate database (`gym_load` by default) on the server in LOAD_DATABASE_URL / the
 * compose PostgreSQL. Seeds members with generate_series, runs the production planner with a
 * forced crash part-way (to prove resume), then verifies constraints, counts, determinism of slot
 * assignment, and measures time, memory, table/index growth, and dashboard read latency.
 * Prints a JSON report for docs/production-capacity-report.md.
 */
import { Pool } from 'pg';
import { CampaignRepository } from '../../src/campaigns/repository';
import { ProductionPlanner } from '../../src/campaigns/production-planner';
import { generateSlots } from '../../src/campaigns/planner';
import { migrate } from '../../src/db/migrate';
import { createPool } from '../../src/db/pool';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const MEMBERS = arg('members', 5_000_000);
const BRANCHES = arg('branches', 100);
const CHUNK = arg('chunk', 50_000);
const CRASH_AT = arg('crash-at', 37);
const ZONES = ['Europe/London', 'Asia/Kathmandu', 'Australia/Sydney', 'America/New_York', 'America/Los_Angeles',
  'Asia/Tokyo', 'Europe/Berlin', 'Asia/Kolkata', 'America/Sao_Paulo', 'Africa/Johannesburg'];
const START = '2026-10-23';
const END = '2026-10-29';

const baseUrl = process.env.LOAD_DATABASE_URL ?? 'postgres://gym:gym@localhost:5433/gym';
const dbName = process.env.LOAD_DATABASE_NAME ?? 'gym_load';

function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  return fn().then((r) => [r, performance.now() - t]);
}

async function main() {
  const admin = createPool(baseUrl, 1);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  const pool: Pool = createPool(url.toString(), 10);
  const report: Record<string, unknown> = { members: MEMBERS, branches: BRANCHES, chunkSize: CHUNK };

  try {
    await migrate(pool);
    const perBranch = Math.floor(MEMBERS / BRANCHES);
    const [, seedMs] = await time(async () => {
      await pool.query(
        `INSERT INTO branches (id, name, time_zone)
         SELECT b, 'Branch ' || b, ($1::text[])[1 + (b - 1) % array_length($1::text[], 1)] FROM generate_series(1, $2::int) b`,
        [ZONES, BRANCHES],
      );
      // 5% opt-out, spread through each branch's id range.
      await pool.query(
        `INSERT INTO members (id, branch_id, name, phone, sms_opt_out)
         SELECT m, 1 + (m - 1) / $1::int, 'Member ' || m, '+1999' || lpad(m::text, 9, '0'), (m % 20) = 0
           FROM generate_series(1, $1::int * $2::int) m`,
        [perBranch, BRANCHES],
      );
      await pool.query(`INSERT INTO campaigns (id, name, start_date, end_date) VALUES (1, 'Load test', $1, $2)`, [START, END]);
      await pool.query(`INSERT INTO campaign_branches SELECT 1, id FROM branches`);
      await pool.query('VACUUM ANALYZE members');
    });
    report.seedSeconds = +(seedMs / 1000).toFixed(1);

    // Memory: sample RSS/heap while planning.
    let peakRss = 0;
    let peakHeap = 0;
    const sampler = setInterval(() => {
      const m = process.memoryUsage();
      peakRss = Math.max(peakRss, m.rss);
      peakHeap = Math.max(peakHeap, m.heapUsed);
    }, 100);

    let chunks = 0;
    const crashing = new ProductionPlanner(pool, {
      chunkSize: CHUNK,
      hooks: { beforeChunkCommit: () => { if (++chunks === CRASH_AT) throw new Error('simulated crash'); } },
    });
    const [crashResult, firstMs] = await time(() => crashing.planAndWait(1, { timeoutMs: 3_600_000 }).then(() => 'completed', (e: Error) => e.message));
    const sendsAfterCrash = Number((await pool.query('SELECT count(*) AS n FROM sends')).rows[0].n);
    const resumer = new ProductionPlanner(pool, { chunkSize: CHUNK });
    const [{ run }, resumeMs] = await time(() => resumer.planAndWait(1, { timeoutMs: 3_600_000 }));
    clearInterval(sampler);
    report.planning = {
      crashedAtChunk: CRASH_AT,
      firstAttempt: crashResult,
      sendsCommittedBeforeCrash: sendsAfterCrash,
      secondsBeforeCrash: +(firstMs / 1000).toFixed(1),
      secondsToResumeAndFinish: +(resumeMs / 1000).toFixed(1),
      totalSeconds: +((firstMs + resumeMs) / 1000).toFixed(1),
      rowsPerSecond: Math.round(MEMBERS / ((firstMs + resumeMs) / 1000)),
      runStatus: run.status,
      runAttempts: run.attempts,
      peakRssMB: Math.round(peakRss / 2 ** 20),
      peakHeapMB: Math.round(peakHeap / 2 ** 20),
    };

    // Verification.
    const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
    const slotsPerBranch = generateSlots(ZONES[0], START, END).length;
    const [totals] = await q(`SELECT count(*)::int AS sends, count(DISTINCT member_id)::int AS members,
                                     count(*) FILTER (WHERE status = 'planned')::int AS planned,
                                     count(*) FILTER (WHERE status = 'skipped_opt_out')::int AS skipped,
                                     count(*) FILTER (WHERE status = 'not_scheduled')::int AS not_scheduled
                                FROM sends`);
    const [dupSlots] = await q(`SELECT count(*)::int AS n FROM (SELECT 1 FROM sends WHERE scheduled_at IS NOT NULL
                                  GROUP BY campaign_id, branch_id, scheduled_at HAVING count(*) > 1) d`);
    const [outOfWindow] = await q(
      `SELECT count(*)::int AS n FROM sends s JOIN branches b ON b.id = s.branch_id
        WHERE s.scheduled_at IS NOT NULL AND (
              extract(isodow FROM s.scheduled_at AT TIME ZONE b.time_zone) = 7
           OR (s.scheduled_at AT TIME ZONE b.time_zone)::time < '09:00'
           OR (s.scheduled_at AT TIME ZONE b.time_zone)::time > '19:58')`,
    );
    // Ordering: within each branch, planned members' slots ascend with member id.
    const [orderViolations] = await q(
      `SELECT count(*)::int AS n FROM (
         SELECT scheduled_at < lag(scheduled_at) OVER (PARTITION BY branch_id ORDER BY member_id) AS bad
           FROM sends WHERE status = 'planned') x WHERE bad`,
    );
    const [drift] = await q(`SELECT count(*)::int AS n FROM reconcile_status_counts(1)`);
    const expectedSkipped = Math.floor(perBranch / 20) * BRANCHES;
    report.verification = {
      ...totals,
      expected: {
        sends: perBranch * BRANCHES,
        planned: Math.min(slotsPerBranch, perBranch - perBranch / 20) * BRANCHES,
        skipped: expectedSkipped,
      },
      duplicateSlots: dupSlots.n,
      slotsOutsideLocalWindow: outOfWindow.n,
      slotOrderViolations: orderViolations.n,
      counterDrift: drift.n,
      unscheduledShareOfEligible: +(totals.not_scheduled / (totals.sends - totals.skipped)).toFixed(4),
    };

    const [sizes] = await q(
      `SELECT pg_total_relation_size('sends') AS sends_total, pg_relation_size('sends') AS sends_heap,
              pg_indexes_size('sends') AS sends_indexes, pg_total_relation_size('campaign_audience_members') AS audience_total,
              pg_database_size(current_database()) AS database`,
    );
    report.storageMB = Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, Math.round(Number(v) / 2 ** 20)]));

    // Dashboard/API read latency on the 5M-row campaign (median of 5).
    const repo = new CampaignRepository(pool);
    const median = async (fn: () => Promise<unknown>) => {
      const xs: number[] = [];
      for (let i = 0; i < 5; i++) xs.push((await time(fn))[1]);
      return +xs.sort((a, b) => a - b)[2].toFixed(1);
    };
    report.readLatencyMs = {
      summary: await median(() => repo.summary(1)),
      firstPage1000: await median(() => repo.listSends(1, { limit: 1000 })),
      deepPageCursor4_9M: await median(() => repo.listSends(1, { limit: 1000, cursor: 4_900_000 })),
      branchStatusFilter: await median(() => repo.listSends(1, { limit: 1000, branchId: 57, status: 'not_scheduled' })),
      rareStatusFilter: await median(() => repo.listSends(1, { limit: 1000, status: 'skipped_opt_out' })),
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
