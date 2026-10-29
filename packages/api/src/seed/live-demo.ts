import { DateTime } from 'luxon';
import { config } from '../config';
import { withTransaction, createPool } from '../db/pool';
import { ProductionPlanner } from '../campaigns/production-planner';
import { isWithinSendWindow } from '../delivery/send-window';

/**
 * `npm run demo:live [-- --zone Europe/London --branches 4 --members 25]`
 *
 * Creates campaign 2, a live (dispatch-enabled) campaign for a few extra branches in a zone whose
 * sending window is open right now, and plans it from the next free slot. With the compose stack
 * running, the dispatcher, relay, workers, and mock provider then send one message per branch
 * every two minutes and the dashboard (?campaign=2) shows them move planned -> sent -> final.
 * Idempotent: re-running returns the existing campaign.
 */
const CAMPAIGN_ID = 2;
const FIRST_BRANCH_ID = 101;
const FIRST_MEMBER_ID = 100_001;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const zone = arg('zone', 'Europe/London');
  const branches = Number(arg('branches', '4'));
  const members = Number(arg('members', '25'));
  if (!isWithinSendWindow(new Date(), zone)) {
    throw new Error(`The Mon–Sat 09:00–20:00 window is closed in ${zone} right now; pass --zone with an open one (e.g. America/New_York).`);
  }
  const pool = createPool(config.databaseUrl, 2);
  try {
    const today = DateTime.now().setZone(zone).toISODate()!;
    await withTransaction(pool, async (client) => {
      for (let b = 0; b < branches; b++) {
        const branchId = FIRST_BRANCH_ID + b;
        await client.query(
          `INSERT INTO branches (id, name, time_zone) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
          [branchId, `Live Smoke ${b + 1}`, zone],
        );
        for (let m = 0; m < members; m++) {
          const id = FIRST_MEMBER_ID + b * 1000 + m;
          await client.query(
            `INSERT INTO members (id, branch_id, name, phone, sms_opt_out) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
            [id, branchId, `Smoke Member #${id}`, `+1555${String(id).padStart(7, '0')}`, m % 10 === 9],
          );
        }
      }
      await client.query(
        `INSERT INTO campaigns (id, name, start_date, end_date, dispatch_enabled) VALUES ($1, 'Live pipeline smoke', $2, $2, true)
         ON CONFLICT (id) DO NOTHING`,
        [CAMPAIGN_ID, today],
      );
      await client.query(
        `INSERT INTO campaign_branches (campaign_id, branch_id) SELECT $1, generate_series($2::int, $3::int) ON CONFLICT DO NOTHING`,
        [CAMPAIGN_ID, FIRST_BRANCH_ID, FIRST_BRANCH_ID + branches - 1],
      );
    });
    const { run } = await new ProductionPlanner(pool).planAndWait(CAMPAIGN_ID);
    const { rows } = await pool.query(
      `SELECT min(scheduled_at) AS first, count(*) FILTER (WHERE status = 'planned')::int AS planned FROM sends WHERE campaign_id = $1`,
      [CAMPAIGN_ID],
    );
    console.log(
      `Campaign ${CAMPAIGN_ID} planned (run ${run.id}): ${rows[0].planned} sends in ${zone}, first at ${rows[0].first?.toISOString()}. ` +
        `Watch http://localhost:8080/?campaign=${CAMPAIGN_ID}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
