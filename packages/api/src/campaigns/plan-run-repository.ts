import { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { ensureAudienceSnapshot } from './audience-snapshot';

export type PlanRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface PlanRunBranch {
  branchId: number;
  timeZone: string;
  audienceRows: number;
  cursorMemberId: number;
  slotsUsed: number;
  planned: number;
  skippedOptOut: number;
  notScheduled: number;
  chunksCommitted: number;
  completedAt: string | null;
}

export interface PlanRun {
  id: number;
  campaignId: number;
  audienceVersion: number;
  status: PlanRunStatus;
  earliestSlotAt: string | null;
  chunkSize: number;
  expectedRows: number;
  processedRows: number;
  attempts: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  branches: PlanRunBranch[];
}

export class PlanRunCampaignNotFound extends Error {}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class PlanRunRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Returns the campaign's plan run, creating it (and the audience snapshot) on first call.
   * Idempotent under concurrency: the campaign row lock serializes callers, and the unique
   * idempotency key plus one-active/one-completed indexes are the database guards.
   * A failed run is put back to `queued` so the caller can resume it from its checkpoints.
   */
  async getOrCreate(campaignId: number, chunkSize: number): Promise<{ run: PlanRun; created: boolean }> {
    const { runId, created } = await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ dispatch_enabled: boolean }>(
        'SELECT dispatch_enabled FROM campaigns WHERE id = $1 FOR UPDATE',
        [campaignId],
      );
      if (!rows[0]) throw new PlanRunCampaignNotFound(`campaign ${campaignId} not found`);

      const existing = await client.query<{ id: number; status: PlanRunStatus }>(
        `SELECT id, status FROM campaign_plan_runs WHERE campaign_id = $1
          ORDER BY (status = 'completed') DESC, id DESC LIMIT 1`,
        [campaignId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].status === 'failed') {
          await client.query(`UPDATE campaign_plan_runs SET status = 'queued', error = NULL, updated_at = now() WHERE id = $1`, [
            existing.rows[0].id,
          ]);
        }
        return { runId: Number(existing.rows[0].id), created: false };
      }

      const audience = await ensureAudienceSnapshot(client, campaignId);
      const { rows: run } = await client.query<{ id: number }>(
        `INSERT INTO campaign_plan_runs (campaign_id, audience_version, idempotency_key, earliest_slot_at, chunk_size, expected_rows)
         VALUES ($1, $2, $3, CASE WHEN $4 THEN date_trunc('minute', now()) + interval '1 minute' END, $5, $6)
         RETURNING id`,
        [campaignId, audience.version, `campaign:${campaignId}:audience:${audience.version}`, rows[0].dispatch_enabled, chunkSize, audience.memberCount],
      );
      await client.query(
        `INSERT INTO campaign_plan_run_branches (plan_run_id, branch_id, time_zone, audience_rows)
         SELECT $1, b.id, b.time_zone, count(a.member_id)
           FROM campaign_branches cb
           JOIN branches b ON b.id = cb.branch_id
           LEFT JOIN campaign_audience_members a
             ON a.campaign_id = cb.campaign_id AND a.audience_version = $3 AND a.branch_id = b.id
          WHERE cb.campaign_id = $2
          GROUP BY b.id`,
        [run[0].id, campaignId, audience.version],
      );
      return { runId: Number(run[0].id), created: true };
    });
    return { run: (await this.get(runId))!, created };
  }

  async get(runId: number, campaignId?: number): Promise<PlanRun | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM campaign_plan_runs WHERE id = $1 AND ($2::int IS NULL OR campaign_id = $2)`,
      [runId, campaignId ?? null],
    );
    const r = rows[0];
    if (!r) return null;
    const { rows: branches } = await this.pool.query(
      `SELECT * FROM campaign_plan_run_branches WHERE plan_run_id = $1 ORDER BY branch_id`,
      [runId],
    );
    const mapped: PlanRunBranch[] = branches.map((b) => ({
      branchId: b.branch_id,
      timeZone: b.time_zone,
      audienceRows: b.audience_rows,
      cursorMemberId: b.cursor_member_id,
      slotsUsed: b.slots_used,
      planned: b.planned,
      skippedOptOut: b.skipped_opt_out,
      notScheduled: b.not_scheduled,
      chunksCommitted: b.chunks_committed,
      completedAt: iso(b.completed_at),
    }));
    return {
      id: Number(r.id),
      campaignId: r.campaign_id,
      audienceVersion: r.audience_version,
      status: r.status,
      earliestSlotAt: iso(r.earliest_slot_at),
      chunkSize: r.chunk_size,
      expectedRows: r.expected_rows,
      processedRows: mapped.reduce((n, b) => n + b.planned + b.skippedOptOut + b.notScheduled, 0),
      attempts: r.attempts,
      error: r.error,
      createdAt: r.created_at.toISOString(),
      startedAt: iso(r.started_at),
      completedAt: iso(r.completed_at),
      branches: mapped,
    };
  }

  async markRunning(client: PoolClient, runId: number): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE campaign_plan_runs
          SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE id = $1 AND status IN ('queued', 'running', 'failed')`,
      [runId],
    );
    return rowCount === 1;
  }

  async markFailed(client: PoolClient, runId: number, error: string): Promise<void> {
    await client.query(
      `UPDATE campaign_plan_runs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 AND status <> 'completed'`,
      [runId, error.slice(0, 2000)],
    );
  }
}
