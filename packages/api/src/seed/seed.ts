import { Pool } from 'pg';
import { withTransaction } from '../db/pool';
import { BRANCHES, CAMPAIGN, buildMembers } from './data';

export interface SeedResult {
  branches: number;
  members: number;
  campaignId: number;
}

/**
 * Idempotently upserts the fixed branches, campaign, campaign-branch links, and members.
 * Never deletes or rewrites sends, so it is safe to run on every API start and after planning.
 */
export async function seed(pool: Pool): Promise<SeedResult> {
  const members = buildMembers();
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO branches (id, name, time_zone)
       SELECT * FROM unnest($1::int[], $2::text[], $3::text[])
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, time_zone = EXCLUDED.time_zone
       WHERE (branches.name, branches.time_zone) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.time_zone)`,
      [BRANCHES.map((b) => b.id), BRANCHES.map((b) => b.name), BRANCHES.map((b) => b.timeZone)],
    );

    await client.query(
      `INSERT INTO members (id, branch_id, name, phone, sms_opt_out)
       SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::bool[])
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, phone = EXCLUDED.phone, sms_opt_out = EXCLUDED.sms_opt_out
       WHERE (members.name, members.phone, members.sms_opt_out)
             IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.phone, EXCLUDED.sms_opt_out)`,
      [
        members.map((m) => m.id),
        members.map((m) => m.branchId),
        members.map((m) => m.name),
        members.map((m) => m.phone),
        members.map((m) => m.smsOptOut),
      ],
    );

    // planned_at is deliberately left untouched: an existing plan stays immutable.
    await client.query(
      `INSERT INTO campaigns (id, name, start_date, end_date) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
       WHERE campaigns.name IS DISTINCT FROM EXCLUDED.name`,
      [CAMPAIGN.id, CAMPAIGN.name, CAMPAIGN.startDate, CAMPAIGN.endDate],
    );

    await client.query(
      `INSERT INTO campaign_branches (campaign_id, branch_id)
       SELECT $1, unnest($2::int[])
       ON CONFLICT DO NOTHING`,
      [CAMPAIGN.id, CAMPAIGN.branchIds],
    );
  });

  return { branches: BRANCHES.length, members: members.length, campaignId: CAMPAIGN.id };
}

/** Explicit destructive path: removes all app rows in FK-safe order and restarts identities. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE provider_events, webhook_receipts, provider_event_applications, provider_event_receipts,
              status_event_outbox, send_outbox, send_attempts, send_attempts_archive,
              campaign_branch_status_counts, sends, campaign_plan_run_branches, campaign_plan_runs,
              campaign_audience_members, campaign_audience_versions,
              campaign_branches, campaigns, members, branches
     RESTART IDENTITY`,
  );
}
