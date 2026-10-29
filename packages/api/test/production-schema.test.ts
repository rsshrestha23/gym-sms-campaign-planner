import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { CampaignRepository } from '../src/campaigns/repository';
import { migrate } from '../src/db/migrate';
import { createPool } from '../src/db/pool';
import { seed } from '../src/seed/seed';
import { count, freshSeed, testPool } from './helpers';

const pool = testPool();

beforeAll(async () => {
  await freshSeed(pool);
  await new CampaignRepository(pool).plan(1);
});
afterAll(() => pool.end());

/** Runs `fn` in a transaction that is always rolled back, so each check leaves no trace. */
async function inRollback(fn: (c: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const firstSend = async (c: PoolClient | Pool, status: string) =>
  (await c.query(`SELECT id FROM sends WHERE status = $1 ORDER BY id LIMIT 1`, [status])).rows[0].id as number;

describe('send dispatch state and claims', () => {
  it('marks existing and newly planned sends with a dispatch state', async () => {
    const { rows } = await pool.query(
      `SELECT status, dispatch_state, count(*)::int AS n FROM sends GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    expect(rows).toEqual([
      { status: 'not_scheduled', dispatch_state: 'complete', n: 120 },
      { status: 'planned', dispatch_state: 'waiting', n: 4640 },
      { status: 'skipped_opt_out', dispatch_state: 'suppressed', n: 240 },
    ]);
  });

  it('rejects an unknown dispatch state', () =>
    inRollback(async (c) => {
      await expect(c.query(`UPDATE sends SET dispatch_state = 'flying' WHERE id = 1`)).rejects.toThrow(/sends_dispatch_state_check/);
    }));

  it('requires a complete claim exactly while claimed', () =>
    inRollback(async (c) => {
      const id = await firstSend(c, 'planned');
      await c.query('SAVEPOINT s');
      await expect(c.query(`UPDATE sends SET dispatch_state = 'claimed' WHERE id = $1`, [id])).rejects.toThrow(/sends_claim_matches_state/);
      await c.query('ROLLBACK TO s');
      await expect(
        c.query(`UPDATE sends SET dispatch_state = 'claimed', claim_token = $2 WHERE id = $1`, [id, randomUUID()]),
      ).rejects.toThrow(/sends_claim_shape/);
      await c.query('ROLLBACK TO s');
      await c.query(
        `UPDATE sends SET dispatch_state = 'claimed', claim_token = $2, claimed_by = 'w1', claim_expires_at = now() + interval '1 minute' WHERE id = $1`,
        [id, randomUUID()],
      );
      await c.query('ROLLBACK TO s');
      await expect(
        c.query(`UPDATE sends SET claim_token = $2, claimed_by = 'w1', claim_expires_at = now() WHERE id = $1`, [id, randomUUID()]),
      ).rejects.toThrow(/sends_claim_matches_state/);
    }));

  it('keeps member, slot, and branch-consistency keys', () =>
    inRollback(async (c) => {
      await c.query('SAVEPOINT s');
      await expect(
        c.query(`INSERT INTO sends (campaign_id, branch_id, member_id, status) VALUES (1, 1, 1, 'not_scheduled')`),
      ).rejects.toThrow(/sends_campaign_member_key/);
      await c.query('ROLLBACK TO s');
      await c.query('DELETE FROM sends WHERE member_id = 2');
      await expect(
        c.query(`INSERT INTO sends (campaign_id, branch_id, member_id, status, scheduled_at) VALUES (1, 2, 2, 'planned', now())`),
      ).rejects.toThrow(/sends_member_branch_fk/);
    }));
});

describe('production status transitions', () => {
  it('lets a late opt-out keep its scheduled time for audit and stay terminal', () =>
    inRollback(async (c) => {
      const id = await firstSend(c, 'planned');
      const before = (await c.query('SELECT scheduled_at FROM sends WHERE id = $1', [id])).rows[0].scheduled_at;
      await c.query(
        `UPDATE sends SET status = 'skipped_opt_out', dispatch_state = 'suppressed', suppression_reason = 'opted_out_after_plan' WHERE id = $1`,
        [id],
      );
      const row = (await c.query('SELECT status, scheduled_at, status_version FROM sends WHERE id = $1', [id])).rows[0];
      expect(row).toEqual({ status: 'skipped_opt_out', scheduled_at: before, status_version: 2 });
      await expect(c.query(`UPDATE sends SET status = 'sent' WHERE id = $1`, [id])).rejects.toThrow(/illegal/);
    }));

  it('marks a missed slot not_scheduled, clearing the slot but keeping it as missed_scheduled_at', () =>
    inRollback(async (c) => {
      const id = await firstSend(c, 'planned');
      const before = (await c.query('SELECT scheduled_at FROM sends WHERE id = $1', [id])).rows[0].scheduled_at;
      await c.query(
        `UPDATE sends SET status = 'not_scheduled', scheduled_at = NULL, dispatch_state = 'suppressed', suppression_reason = 'missed_slot' WHERE id = $1`,
        [id],
      );
      const row = (await c.query('SELECT status, scheduled_at, missed_scheduled_at FROM sends WHERE id = $1', [id])).rows[0];
      expect(row).toEqual({ status: 'not_scheduled', scheduled_at: null, missed_scheduled_at: before });
    }));

  it('still forbids moving a slot or reopening final statuses', () =>
    inRollback(async (c) => {
      const id = await firstSend(c, 'planned');
      await c.query('SAVEPOINT s');
      await expect(c.query(`UPDATE sends SET scheduled_at = scheduled_at + interval '2 minutes' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
      await c.query('ROLLBACK TO s');
      await expect(c.query(`UPDATE sends SET scheduled_at = NULL WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
      await c.query('ROLLBACK TO s');
      await c.query(`UPDATE sends SET status = 'delivered' WHERE id = $1`, [id]);
      await expect(c.query(`UPDATE sends SET status = 'failed' WHERE id = $1`, [id])).rejects.toThrow(/illegal/);
    }));

  it('requires null schedules for not_scheduled and real ones for planned', () =>
    inRollback(async (c) => {
      await c.query('DELETE FROM sends WHERE member_id = 2');
      await c.query('SAVEPOINT s');
      await expect(
        c.query(`INSERT INTO sends (campaign_id, branch_id, member_id, status, scheduled_at) VALUES (1, 1, 2, 'not_scheduled', now())`),
      ).rejects.toThrow(/sends_schedule_matches_status/);
      await c.query('ROLLBACK TO s');
      await expect(
        c.query(`INSERT INTO sends (campaign_id, branch_id, member_id, status) VALUES (1, 1, 2, 'planned')`),
      ).rejects.toThrow(/sends_schedule_matches_status/);
    }));
});

describe('attempts, outboxes, and provider events', () => {
  const attempt = (c: PoolClient, sendId: number, n: number) =>
    c.query(
      `INSERT INTO send_attempts (send_id, attempt_number, dispatch_generation, worker_id, lease_token, idempotency_key)
       VALUES ($1, $2, 1, 'w1', $3, $4) RETURNING id`,
      [sendId, n, randomUUID(), `campaign-send:${sendId}`],
    );

  it('keeps attempts append-only: finish once, never rewrite or delete', () =>
    inRollback(async (c) => {
      const sendId = await firstSend(c, 'planned');
      const { rows } = await attempt(c, sendId, 1);
      await c.query('SAVEPOINT s');
      await expect(attempt(c, sendId, 1)).rejects.toThrow(/send_attempts_send_id_attempt_number_key/);
      await c.query('ROLLBACK TO s');
      await c.query(`UPDATE send_attempts SET outcome = 'accepted', finished_at = now(), provider_message_id = 'pm-1' WHERE id = $1`, [rows[0].id]);
      await c.query('SAVEPOINT s2');
      await expect(c.query(`UPDATE send_attempts SET outcome = 'permanent_error' WHERE id = $1`, [rows[0].id])).rejects.toThrow(/immutable/);
      await c.query('ROLLBACK TO s2');
      await expect(c.query(`DELETE FROM send_attempts WHERE id = $1`, [rows[0].id])).rejects.toThrow(/append-only/);
    }));

  it('allows one dispatch outbox row per send generation', () =>
    inRollback(async (c) => {
      const sendId = await firstSend(c, 'planned');
      const insert = (gen: number) =>
        c.query(
          `INSERT INTO send_outbox (send_id, event_type, dispatch_generation, job_id, payload) VALUES ($1, 'dispatch', $2, 'j', '{}')`,
          [sendId, gen],
        );
      await insert(1);
      await insert(2); // an operator retry is a new generation
      await expect(insert(1)).rejects.toThrow(/send_outbox_generation_key/);
    }));

  it('keeps provider event ids globally unique across receipt partitions', () =>
    inRollback(async (c) => {
      const old = await c.query(
        `INSERT INTO provider_event_receipts (received_at, raw_body, auth_status) VALUES ('2020-01-01', '\\x00', 'valid') RETURNING id, received_at`,
      );
      const recent = await c.query(
        `INSERT INTO provider_event_receipts (raw_body, auth_status) VALUES ('\\x00', 'valid') RETURNING id, received_at`,
      );
      const apply = (r: { id: number; received_at: Date }) =>
        c.query(
          `INSERT INTO provider_event_applications (event_id, receipt_id, receipt_received_at, send_id, status, occurred_at, payload_sha256, disposition)
           VALUES ('evt-global', $1, $2, 1, 'sent', now(), '\\x00', 'applied')`,
          [r.id, r.received_at],
        );
      await apply(old.rows[0]);
      await expect(apply(recent.rows[0])).rejects.toThrow(/provider_event_applications_pkey/);
    }));

  it('routes receipts into monthly partitions with a default catch-all', async () => {
    const { rows } = await pool.query(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'provider_event_receipts'::regclass ORDER BY 1`,
    );
    const names = rows.map((r) => r.relname);
    expect(names).toContain('provider_event_receipts_default');
    expect(names).toContain(`provider_event_receipts_${new Date().toISOString().slice(0, 7).replace('-', '_')}`);
    await inRollback(async (c) => {
      const r = await c.query(
        `INSERT INTO provider_event_receipts (raw_body, auth_status) VALUES ('\\x01', 'valid') RETURNING tableoid::regclass::text AS part`,
      );
      expect(r.rows[0].part).toMatch(/^provider_event_receipts_\d{4}_\d{2}$/);
    });
  });
});

describe('plan runs and audience snapshots', () => {
  it('allows only one active and one completed plan run per campaign', () =>
    inRollback(async (c) => {
      const run = (key: string, status: string) =>
        c.query(
          `INSERT INTO campaign_plan_runs (campaign_id, audience_version, idempotency_key, status, chunk_size, expected_rows, completed_at)
           VALUES (1, (SELECT audience_version FROM campaigns WHERE id = 1), $1, $2, 100, 0, CASE WHEN $2 = 'completed' THEN now() END)`,
          [key, status],
        );
      await c.query('SAVEPOINT s');
      // The seeded plan already has a completed run.
      await expect(run('dup-completed', 'completed')).rejects.toThrow(/campaign_plan_runs_one_completed/);
      await c.query('ROLLBACK TO s');
      await run('a', 'running');
      await expect(run('b', 'queued')).rejects.toThrow(/campaign_plan_runs_one_active/);
    }));

  it('freezes a finalized audience snapshot', () =>
    inRollback(async (c) => {
      await c.query('SAVEPOINT s');
      await expect(c.query(`DELETE FROM campaign_audience_members WHERE campaign_id = 1 AND member_id = 1`)).rejects.toThrow(/immutable/);
      await c.query('ROLLBACK TO s');
      await expect(
        c.query(`UPDATE campaign_audience_versions SET member_count = 1 WHERE campaign_id = 1`),
      ).rejects.toThrow(/immutable/);
    }));
});

describe('retention procedures', () => {
  it('refuses to purge dedupe keys inside the provider retry window', () =>
    inRollback(async (c) => {
      await c.query('SAVEPOINT s');
      await expect(
        c.query(`SELECT purge_provider_event_applications(now() - interval '1 day', interval '30 days')`),
      ).rejects.toThrow(/refusing to purge/);
      await c.query('ROLLBACK TO s');
      const { rows } = await c.query(`SELECT purge_provider_event_applications(now() - interval '31 days', interval '30 days') AS n`);
      expect(rows[0].n).toBe(0);
    }));

  it('drops whole expired receipt partitions and sweeps the default partition', () =>
    inRollback(async (c) => {
      await c.query(`SELECT ensure_provider_receipt_partitions('2020-01-01', 2)`);
      await c.query(`INSERT INTO provider_event_receipts (received_at, raw_body, auth_status) VALUES ('2020-01-15', '\\x01', 'valid')`);
      await c.query(`INSERT INTO provider_event_receipts (received_at, raw_body, auth_status) VALUES ('2019-06-01', '\\x01', 'valid')`);
      const { rows } = await c.query(`SELECT drop_expired_provider_receipts('2020-03-01') AS dropped`);
      expect(rows[0].dropped).toBe(2);
      expect((await c.query(`SELECT count(*)::int AS n FROM provider_event_receipts WHERE received_at < '2020-03-01'`)).rows[0].n).toBe(0);
    }));

  it('archives finished attempts through the sanctioned path only', () =>
    inRollback(async (c) => {
      const sendId = await firstSend(c, 'planned');
      await c.query(
        `INSERT INTO send_attempts (send_id, attempt_number, dispatch_generation, worker_id, lease_token, idempotency_key, outcome, finished_at, started_at)
         VALUES ($1, 1, 1, 'w', $2, 'k', 'accepted', now() - interval '2 years', now() - interval '2 years')`,
        [sendId, randomUUID()],
      );
      const { rows } = await c.query(`SELECT archive_send_attempts(now() - interval '1 year') AS moved`);
      expect(rows[0].moved).toBe(1);
      expect((await c.query(`SELECT count(*)::int AS n FROM send_attempts_archive WHERE send_id = $1`, [sendId])).rows[0].n).toBe(1);
      expect((await c.query(`SELECT current_setting('app.retention', true) AS v`)).rows[0].v).toBe('off');
    }));
});

describe('forward migration from the demo schema', () => {
  let upgradePool: Pool;

  beforeAll(async () => {
    await pool.query('DROP DATABASE IF EXISTS gym_upgrade');
    await pool.query('CREATE DATABASE gym_upgrade');
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/gym_upgrade';
    upgradePool = createPool(url.toString(), 4);
  });
  afterAll(async () => {
    await upgradePool.end();
    await pool.query('DROP DATABASE IF EXISTS gym_upgrade');
  });

  it('upgrades a demo database with live data and keeps the old write paths working', async () => {
    // 1. Demo release: schema 001 only, seeded, planned, with webhook history.
    await migrate(upgradePool, { until: '001_initial.sql' });
    await seed(upgradePool);
    const slot = '2026-10-23T08:00:00Z';
    await upgradePool.query(
      `INSERT INTO sends (campaign_id, branch_id, member_id, status, scheduled_at) VALUES (1, 1, 1, 'planned', $1), (1, 1, 22, 'skipped_opt_out', NULL)`,
      [slot],
    );
    await upgradePool.query(`UPDATE sends SET status = 'delivered' WHERE member_id = 1`);
    const receipt = await upgradePool.query(`INSERT INTO webhook_receipts (raw_body) VALUES ('{"eventId":"legacy-1"}') RETURNING id`);
    await upgradePool.query(
      `INSERT INTO provider_events (event_id, receipt_id, send_id, status, occurred_at, disposition) VALUES ('legacy-1', $1, 1, 'delivered', now(), 'applied')`,
      [receipt.rows[0].id],
    );

    // 2. Production release migrations, on top of live data.
    expect(await migrate(upgradePool)).toEqual(['002_production_delivery.sql', '003_delivery_indexes.sql', '004_status_projection.sql']);

    const { rows: sends } = await upgradePool.query(`SELECT member_id, status, dispatch_state FROM sends ORDER BY member_id`);
    expect(sends).toEqual([
      { member_id: 1, status: 'delivered', dispatch_state: 'complete' },
      { member_id: 22, status: 'skipped_opt_out', dispatch_state: 'suppressed' },
    ]);
    // Dedupe history and raw bodies were carried over.
    const { rows: apps } = await upgradePool.query(`SELECT event_id, disposition FROM provider_event_applications`);
    expect(apps).toEqual([{ event_id: 'legacy-1', disposition: 'applied' }]);
    expect(await count(upgradePool, `SELECT count(*) AS n FROM provider_event_receipts`)).toBe(1);
    // New receipts don't collide with backfilled ids.
    const next = await upgradePool.query(`INSERT INTO provider_event_receipts (raw_body, auth_status) VALUES ('\\x00', 'valid') RETURNING id`);
    expect(Number(next.rows[0].id)).toBeGreaterThan(Number(receipt.rows[0].id));
    // Counters were backfilled from existing sends.
    const { rows: counts } = await upgradePool.query(`SELECT status, count::int FROM campaign_branch_status_counts ORDER BY status`);
    expect(counts).toEqual([{ status: 'delivered', count: 1 }, { status: 'skipped_opt_out', count: 1 }]);

    // 3. Expand-compatibility: the previous release's INSERT/UPDATE statements still succeed.
    await upgradePool.query(`INSERT INTO sends (campaign_id, branch_id, member_id, status, scheduled_at) VALUES (1, 1, 3, 'planned', '2026-10-23T08:02:00Z')`);
    await upgradePool.query(`UPDATE sends SET status = 'sent' WHERE member_id = 3 AND status = 'planned'`);
    const r2 = await upgradePool.query(`INSERT INTO webhook_receipts (raw_body) VALUES ('x') RETURNING id`);
    await upgradePool.query(
      `INSERT INTO provider_events (event_id, receipt_id, send_id, status, occurred_at, disposition, reason) VALUES ('legacy-2', $1, 3, 'sent', now(), 'ignored', 'stale')`,
      [r2.rows[0].id],
    );

    // 4. Re-running is a no-op.
    expect(await migrate(upgradePool)).toEqual([]);
  });
});
