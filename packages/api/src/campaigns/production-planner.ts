import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Pool, PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { generateSlots, PlannedStatus } from './planner';
import { PlanRun, PlanRunRepository } from './plan-run-repository';

export interface PlannerHooks {
  /** Fault injection for tests: called inside the chunk transaction, before COMMIT. */
  beforeChunkCommit?: (ctx: { runId: number; branchId: number; chunk: number }) => void | Promise<void>;
  /** Called after a chunk transaction committed. */
  afterChunkCommit?: (ctx: { runId: number; branchId: number; chunk: number }) => void | Promise<void>;
}

export interface ProductionPlannerOptions {
  chunkSize?: number;
  hooks?: PlannerHooks;
}

export type ExecuteResult = 'completed' | 'busy' | 'not_runnable';

/** Advisory-lock namespace for plan runs: (namespace, run id). */
const PLAN_RUN_LOCK_NAMESPACE = 4_277_002;
const DEFAULT_CHUNK_SIZE = 10_000;

interface ChunkRow {
  memberId: number;
  status: PlannedStatus;
  scheduledAt: string | null;
}

interface BranchCheckpoint {
  branch_id: number;
  time_zone: string;
  audience_rows: number;
  cursor_member_id: number;
  slots_used: number;
  planned: number;
  skipped_opt_out: number;
  not_scheduled: number;
  chunks_committed: number;
  completed_at: Date | null;
}

const DISPATCH_STATE: Record<PlannedStatus, string> = {
  planned: 'waiting',
  skipped_opt_out: 'suppressed',
  not_scheduled: 'complete',
};

/**
 * Resumable bulk planner for large audiences.
 *
 * Streams the immutable audience snapshot branch by branch in member-ID order, a chunk at a time,
 * so memory is bounded by the chunk size, not the audience. Each chunk is COPYed into a temporary
 * staging table and merged into `sends` in the same transaction that advances that branch's
 * checkpoint (member cursor + slots used + counts). A crash rolls back the chunk and its checkpoint
 * together, so a resumed run continues exactly where the last commit left off with the same slot
 * index: the result is identical to an uninterrupted run. The run completes, and the campaign is
 * marked planned, only after per-branch and total counts reconcile against the snapshot.
 */
export class ProductionPlanner {
  readonly chunkSize: number;
  private readonly runs: PlanRunRepository;
  private readonly hooks: PlannerHooks;

  constructor(private readonly pool: Pool, options: ProductionPlannerOptions = {}) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.hooks = options.hooks ?? {};
    this.runs = new PlanRunRepository(pool);
  }

  start(campaignId: number): Promise<{ run: PlanRun; created: boolean }> {
    return this.runs.getOrCreate(campaignId, this.chunkSize);
  }

  getRun(runId: number, campaignId?: number): Promise<PlanRun | null> {
    return this.runs.get(runId, campaignId);
  }

  /**
   * Executes (or resumes) a run. The session advisory lock guarantees one executor per run across
   * every API instance; it is released automatically if this process dies, which is what lets a
   * later request pick up an orphaned `running` run.
   */
  async execute(runId: number): Promise<ExecuteResult> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [
        PLAN_RUN_LOCK_NAMESPACE,
        runId,
      ]);
      locked = lock.rows[0].ok;
      if (!locked) return 'busy';

      const { rows } = await client.query(
        `SELECT r.*, c.start_date, c.end_date FROM campaign_plan_runs r JOIN campaigns c ON c.id = r.campaign_id WHERE r.id = $1`,
        [runId],
      );
      const run = rows[0];
      if (!run || run.status === 'completed') return 'not_runnable';
      if (!(await this.runs.markRunning(client, runId))) return 'not_runnable';

      try {
        const { rows: branches } = await client.query<BranchCheckpoint>(
          `SELECT * FROM campaign_plan_run_branches WHERE plan_run_id = $1 ORDER BY branch_id`,
          [runId],
        );
        for (const branch of branches) {
          if (branch.completed_at) continue;
          await this.planBranch(client, run, branch);
        }
        await this.complete(client, runId);
        return 'completed';
      } catch (err) {
        await this.runs.markFailed(client, runId, err instanceof Error ? err.message : String(err)).catch(() => undefined);
        throw err;
      }
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock($1, $2)', [PLAN_RUN_LOCK_NAMESPACE, runId]).catch(() => undefined);
      client.release();
    }
  }

  private async planBranch(
    client: PoolClient,
    run: { id: number; campaign_id: number; audience_version: number; earliest_slot_at: Date | null; chunk_size: number; start_date: string; end_date: string },
    branch: BranchCheckpoint,
  ): Promise<void> {
    const earliest = run.earliest_slot_at ? run.earliest_slot_at.toISOString() : null;
    // ~2k slots per branch-week: cheap to regenerate on every resume, and deterministic.
    const slots = generateSlots(branch.time_zone, run.start_date, run.end_date).filter((s) => !earliest || s >= earliest);
    let state = { ...branch };

    for (;;) {
      const { rows: audience } = await client.query<{ member_id: number; opted_out_at_plan: boolean }>(
        `SELECT member_id, opted_out_at_plan FROM campaign_audience_members
          WHERE campaign_id = $1 AND audience_version = $2 AND branch_id = $3 AND member_id > $4
          ORDER BY member_id LIMIT $5`,
        [run.campaign_id, run.audience_version, branch.branch_id, state.cursor_member_id, run.chunk_size],
      );
      if (audience.length === 0) break;

      let slotsUsed = state.slots_used;
      const counts = { planned: 0, skipped_opt_out: 0, not_scheduled: 0 };
      const rows: ChunkRow[] = audience.map((a) => {
        let row: ChunkRow;
        if (a.opted_out_at_plan) row = { memberId: a.member_id, status: 'skipped_opt_out', scheduledAt: null };
        else if (slotsUsed < slots.length) row = { memberId: a.member_id, status: 'planned', scheduledAt: slots[slotsUsed++] };
        else row = { memberId: a.member_id, status: 'not_scheduled', scheduledAt: null };
        counts[row.status]++;
        return row;
      });
      const nextCursor = audience[audience.length - 1].member_id;
      const chunk = state.chunks_committed + 1;

      await client.query('BEGIN');
      try {
        await this.loadChunk(client, run, branch.branch_id, rows);
        // Verify before checkpointing: every member in (cursor, nextCursor] now has exactly one send.
        const { rows: check } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM sends WHERE campaign_id = $1 AND branch_id = $2 AND member_id > $3 AND member_id <= $4`,
          [run.campaign_id, branch.branch_id, state.cursor_member_id, nextCursor],
        );
        if (check[0].n !== rows.length) {
          throw new Error(
            `plan run ${run.id} branch ${branch.branch_id}: expected ${rows.length} sends in chunk ${chunk}, found ${check[0].n}`,
          );
        }
        await client.query(
          `UPDATE campaign_plan_run_branches
              SET cursor_member_id = $3, slots_used = $4, planned = planned + $5, skipped_opt_out = skipped_opt_out + $6,
                  not_scheduled = not_scheduled + $7, chunks_committed = $8
            WHERE plan_run_id = $1 AND branch_id = $2`,
          [run.id, branch.branch_id, nextCursor, slotsUsed, counts.planned, counts.skipped_opt_out, counts.not_scheduled, chunk],
        );
        await client.query('UPDATE campaign_plan_runs SET updated_at = now() WHERE id = $1', [run.id]);
        await this.hooks.beforeChunkCommit?.({ runId: run.id, branchId: branch.branch_id, chunk });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
      await this.hooks.afterChunkCommit?.({ runId: run.id, branchId: branch.branch_id, chunk });

      state = {
        ...state,
        cursor_member_id: nextCursor,
        slots_used: slotsUsed,
        planned: state.planned + counts.planned,
        skipped_opt_out: state.skipped_opt_out + counts.skipped_opt_out,
        not_scheduled: state.not_scheduled + counts.not_scheduled,
        chunks_committed: chunk,
      };
    }

    const done = await client.query(
      `UPDATE campaign_plan_run_branches SET completed_at = now()
        WHERE plan_run_id = $1 AND branch_id = $2
          AND planned + skipped_opt_out + not_scheduled = audience_rows`,
      [run.id, branch.branch_id],
    );
    if (done.rowCount !== 1) {
      throw new Error(`plan run ${run.id} branch ${branch.branch_id}: checkpoint counts do not match the audience snapshot`);
    }
  }

  /** COPY into a per-transaction staging table, then merge under the (campaign, member) key. */
  private async loadChunk(
    client: PoolClient,
    run: { id: number; campaign_id: number },
    branchId: number,
    rows: ChunkRow[],
  ): Promise<void> {
    await client.query(
      `CREATE TEMP TABLE IF NOT EXISTS plan_chunk_staging (
         member_id integer NOT NULL, status text NOT NULL, scheduled_at timestamptz, dispatch_state text NOT NULL
       ) ON COMMIT DELETE ROWS`,
    );
    const lines = rows.map(
      (r) => `${r.memberId}\t${r.status}\t${r.scheduledAt ?? '\\N'}\t${DISPATCH_STATE[r.status]}\n`,
    );
    await pipeline(
      Readable.from(lines),
      client.query(copyFrom('COPY plan_chunk_staging (member_id, status, scheduled_at, dispatch_state) FROM STDIN')),
    );
    await client.query(
      `INSERT INTO sends (campaign_id, branch_id, member_id, status, scheduled_at, dispatch_state, plan_run_id)
       SELECT $1, $2, member_id, status, scheduled_at, dispatch_state, $3 FROM plan_chunk_staging ORDER BY member_id
       ON CONFLICT (campaign_id, member_id) DO NOTHING`,
      [run.campaign_id, branchId, run.id],
    );
  }

  /** Atomically completes the run and marks the campaign planned, after a full reconciliation. */
  private async complete(client: PoolClient, runId: number): Promise<void> {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query<{ campaign_id: number; expected_rows: number; actual: number; pending: number }>(
        `SELECT r.campaign_id, r.expected_rows,
                (SELECT count(*)::int FROM sends s WHERE s.campaign_id = r.campaign_id) AS actual,
                (SELECT count(*)::int FROM campaign_plan_run_branches b WHERE b.plan_run_id = r.id AND b.completed_at IS NULL) AS pending
           FROM campaign_plan_runs r WHERE r.id = $1 FOR UPDATE`,
        [runId],
      );
      const r = rows[0];
      if (r.pending > 0 || r.actual !== r.expected_rows) {
        throw new Error(`plan run ${runId} does not reconcile: ${r.actual}/${r.expected_rows} sends, ${r.pending} branches pending`);
      }
      await client.query(
        `UPDATE campaign_plan_runs SET status = 'completed', completed_at = now(), error = NULL, updated_at = now() WHERE id = $1`,
        [runId],
      );
      await client.query('UPDATE campaigns SET planned_at = COALESCE(planned_at, now()) WHERE id = $1', [r.campaign_id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  /** Synchronous plan for API callers that want the finished plan in the response. */
  async planAndWait(campaignId: number, { timeoutMs = 120_000, pollMs = 50 } = {}): Promise<{ run: PlanRun; created: boolean }> {
    const { run, created } = await this.start(campaignId);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = (await this.getRun(run.id))!;
      if (current.status === 'completed') return { run: current, created };
      const result = await this.execute(run.id);
      if (result === 'completed') return { run: (await this.getRun(run.id))!, created };
      if (Date.now() > deadline) throw new Error(`plan run ${run.id} did not complete within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, pollMs)); // another executor holds the run; wait for it
    }
  }
}
