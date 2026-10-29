import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate';
import { CampaignRepository } from '../src/campaigns/repository';
import { count, freshSeed, testPool } from './helpers';

const pool = testPool();

beforeAll(async () => {
  await freshSeed(pool);
  await new CampaignRepository(pool).plan(1);
});
afterAll(() => pool.end());

async function columns(table: string): Promise<string[]> {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

async function sendStatus(id: number) {
  const { rows } = await pool.query('SELECT status, status_version, updated_at FROM sends WHERE id = $1', [id]);
  return rows[0] as { status: string; status_version: number; updated_at: Date };
}

async function firstSendWith(status: string): Promise<number> {
  const { rows } = await pool.query('SELECT id FROM sends WHERE status = $1 ORDER BY id LIMIT 1', [status]);
  return rows[0].id;
}

describe('schema', () => {
  it('is idempotent to re-run', async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it('has the required tables and columns', async () => {
    expect(await columns('branches')).toEqual(['id', 'name', 'time_zone']);
    expect(await columns('members')).toEqual(['branch_id', 'id', 'name', 'phone', 'sms_opt_out']);
    expect(await columns('campaigns')).toEqual(['end_date', 'id', 'name', 'planned_at', 'start_date']);
    expect(await columns('campaign_branches')).toEqual(['branch_id', 'campaign_id']);
    expect(await columns('sends')).toEqual([
      'branch_id', 'campaign_id', 'created_at', 'id', 'member_id', 'scheduled_at', 'status', 'status_version', 'updated_at',
    ]);
    expect(await columns('webhook_receipts')).toEqual(['content_type', 'id', 'raw_body', 'received_at']);
    expect(await columns('provider_events')).toEqual([
      'disposition', 'event_id', 'occurred_at', 'processed_at', 'reason', 'receipt_id', 'send_id', 'status',
    ]);
  });

  it('declares the composite keys and the partial slot index', async () => {
    const { rows: constraints } = await pool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid IN ('members'::regclass, 'sends'::regclass)`,
    );
    const defs = constraints.map((c) => c.def);
    expect(defs).toContain('UNIQUE (id, branch_id)');
    expect(defs).toContain('UNIQUE (campaign_id, member_id)');
    expect(defs).toContain('FOREIGN KEY (member_id, branch_id) REFERENCES members(id, branch_id)');

    const { rows: idx } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'sends_campaign_branch_slot_key'`,
    );
    expect(idx[0].indexdef).toMatch(/UNIQUE INDEX .* \(campaign_id, branch_id, scheduled_at\) WHERE \(scheduled_at IS NOT NULL\)/);
  });

  it('rejects an unknown status and a schedule/status mismatch', async () => {
    await expect(
      pool.query(
        `INSERT INTO sends (campaign_id, branch_id, member_id, status, scheduled_at) VALUES (1, 1, 1, 'bogus', now())`,
      ),
    ).rejects.toThrow(/sends_status_check/);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM sends WHERE member_id = 2');
      await expect(
        client.query(`INSERT INTO sends (campaign_id, branch_id, member_id, status) VALUES (1, 1, 2, 'planned')`),
      ).rejects.toThrow(/sends_schedule_matches_status/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects a send whose branch disagrees with its member', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM sends WHERE member_id = 2');
      await expect(
        client.query(
          `INSERT INTO sends (campaign_id, branch_id, member_id, status, scheduled_at)
           VALUES (1, 2, 2, 'planned', '2030-01-01T00:00:00Z')`,
        ),
      ).rejects.toThrow(/sends_member_branch_fk/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects a duplicate member or slot within a campaign', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(`INSERT INTO sends (campaign_id, branch_id, member_id, status) VALUES (1, 1, 1, 'skipped_opt_out')`),
      ).rejects.toThrow(/sends_campaign_member_key/);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT scheduled_at FROM sends WHERE member_id = 1`);
      await client.query('DELETE FROM sends WHERE member_id = 22'); // member 22 is opted out
      await expect(
        client.query(
          `INSERT INTO sends (campaign_id, branch_id, member_id, status, scheduled_at) VALUES (1, 1, 22, 'planned', $1)`,
          [rows[0].scheduled_at],
        ),
      ).rejects.toThrow(/sends_campaign_branch_slot_key/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('status transition trigger', () => {
  it('treats a same-status update as a no-op without bumping status_version', async () => {
    const id = await firstSendWith('planned');
    const before = await sendStatus(id);
    await pool.query(`UPDATE sends SET status = 'planned' WHERE id = $1`, [id]);
    const after = await sendStatus(id);
    expect(after.status_version).toBe(before.status_version);
    expect(after.updated_at).toEqual(before.updated_at);
  });

  it('allows planned -> sent -> final and bumps status_version on each change', async () => {
    const id = await firstSendWith('planned');
    await pool.query(`UPDATE sends SET status = 'sent' WHERE id = $1`, [id]);
    expect(await sendStatus(id)).toMatchObject({ status: 'sent', status_version: 2 });
    await pool.query(`UPDATE sends SET status = 'sent' WHERE id = $1`, [id]);
    expect(await sendStatus(id)).toMatchObject({ status: 'sent', status_version: 2 });
    await pool.query(`UPDATE sends SET status = 'delivered' WHERE id = $1`, [id]);
    expect(await sendStatus(id)).toMatchObject({ status: 'delivered', status_version: 3 });
  });

  it('allows planned -> final directly', async () => {
    const id = await firstSendWith('planned');
    await pool.query(`UPDATE sends SET status = 'failed' WHERE id = $1`, [id]);
    expect(await sendStatus(id)).toMatchObject({ status: 'failed', status_version: 2 });
  });

  it('rejects regressions, final changes, and leaving non-provider statuses', async () => {
    const delivered = await firstSendWith('delivered');
    await expect(pool.query(`UPDATE sends SET status = 'sent' WHERE id = $1`, [delivered])).rejects.toThrow(/illegal/);
    await expect(pool.query(`UPDATE sends SET status = 'failed' WHERE id = $1`, [delivered])).rejects.toThrow(/illegal/);
    await expect(pool.query(`UPDATE sends SET status = 'planned' WHERE id = $1`, [delivered])).rejects.toThrow(/illegal/);

    const sent = await firstSendWith('planned');
    await pool.query(`UPDATE sends SET status = 'sent' WHERE id = $1`, [sent]);
    await expect(pool.query(`UPDATE sends SET status = 'planned' WHERE id = $1`, [sent])).rejects.toThrow(/illegal/);

    const skipped = await firstSendWith('skipped_opt_out');
    await expect(pool.query(`UPDATE sends SET status = 'sent' WHERE id = $1`, [skipped])).rejects.toThrow(/illegal/);
    const unscheduled = await firstSendWith('not_scheduled');
    await expect(pool.query(`UPDATE sends SET status = 'delivered' WHERE id = $1`, [unscheduled])).rejects.toThrow();
  });

  it('keeps plan fields immutable', async () => {
    const id = await firstSendWith('planned');
    await expect(
      pool.query(`UPDATE sends SET scheduled_at = scheduled_at + interval '2 minutes' WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    expect(await count(pool, 'SELECT count(*) AS n FROM sends')).toBe(5000);
  });
});
