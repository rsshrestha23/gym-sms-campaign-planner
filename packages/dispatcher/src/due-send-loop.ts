import { Pool } from 'pg';
import { withTransaction } from '../../api/src/db/pool';
import { insertDispatchOutbox, recordStatusChange, SEND_CHANGE_COLUMNS, toStatusChange } from '../../api/src/delivery/repository';
import { DEFAULT_MISSED_SLOT_GRACE_MS, slotVerdict } from '../../api/src/delivery/send-window';
import { dispatchJobId } from '../../api/src/delivery/types';

export interface DispatchOptions {
  batchSize?: number;
  /** Injected clock for tests; production uses the database clock for the due cutoff. */
  now?: Date;
  missedSlotGraceMs?: number;
  /** Optional horizontal partitioning: this dispatcher only handles branches where branch_id % count = index. */
  shard?: { index: number; count: number };
}

export interface DispatchResult {
  queued: number;
  missed: number;
  examined: number;
}

/**
 * One due-send pass. In a single transaction: lock a bounded batch of due rows with
 * FOR UPDATE SKIP LOCKED (so any number of dispatchers can run), move sends that can still go out
 * to `queued` with a new dispatch generation plus an outbox row, and apply the missed-slot policy
 * to the rest. Nothing reaches Redis here; the outbox relay does that after commit.
 * Rows are only selected once scheduled_at <= now, so nothing is ever dispatched early.
 */
export async function dispatchDueBatch(pool: Pool, options: DispatchOptions = {}): Promise<DispatchResult> {
  const batchSize = options.batchSize ?? 500;
  const graceMs = options.missedSlotGraceMs ?? DEFAULT_MISSED_SLOT_GRACE_MS;
  const shard = options.shard ?? { index: 0, count: 1 };

  return withTransaction(pool, async (client) => {
    const { rows: nowRow } = await client.query<{ now: Date }>('SELECT COALESCE($1::timestamptz, now()) AS now', [
      options.now ?? null,
    ]);
    const now = nowRow[0].now;

    const { rows: due } = await client.query<{
      id: number;
      campaign_id: number;
      scheduled_at: Date;
      time_zone: string;
    }>(
      `SELECT s.id, s.campaign_id, s.scheduled_at, b.time_zone
         FROM sends s
         JOIN campaigns c ON c.id = s.campaign_id
         JOIN branches b ON b.id = s.branch_id
        WHERE s.status = 'planned' AND s.dispatch_state = 'waiting' AND s.scheduled_at <= $1
          AND c.dispatch_enabled AND c.paused_at IS NULL AND c.cancelled_at IS NULL
          AND s.branch_id % $3 = $4
        ORDER BY s.scheduled_at, s.id
        LIMIT $2
        FOR UPDATE OF s SKIP LOCKED`,
      [now, batchSize, shard.count, shard.index],
    );

    const toQueue: typeof due = [];
    const missed: number[] = [];
    for (const send of due) {
      const verdict = slotVerdict(send.scheduled_at, now, send.time_zone, graceMs);
      if (verdict === 'send') toQueue.push(send);
      else if (verdict === 'missed') missed.push(send.id);
    }

    if (toQueue.length) {
      const { rows: queued } = await client.query<{ id: number; campaign_id: number; dispatch_generation: number }>(
        `UPDATE sends SET dispatch_state = 'queued', dispatch_generation = dispatch_generation + 1
          WHERE id = ANY($1) RETURNING id, campaign_id, dispatch_generation`,
        [toQueue.map((s) => s.id)],
      );
      await client.query(
        `INSERT INTO send_outbox (send_id, event_type, dispatch_generation, job_id, payload)
         SELECT q.id, 'dispatch', q.gen, q.job_id, jsonb_build_object('sendId', q.id, 'campaignId', q.campaign_id, 'dispatchGeneration', q.gen)
           FROM unnest($1::int[], $2::int[], $3::int[], $4::text[]) AS q(id, campaign_id, gen, job_id)
         ON CONFLICT (send_id, event_type, dispatch_generation) DO NOTHING`,
        [
          queued.map((q) => q.id),
          queued.map((q) => q.campaign_id),
          queued.map((q) => q.dispatch_generation),
          queued.map((q) => dispatchJobId(q.id, q.dispatch_generation)),
        ],
      );
    }

    if (missed.length) {
      const { rows: changed } = await client.query(
        `UPDATE sends SET status = 'not_scheduled', scheduled_at = NULL, dispatch_state = 'suppressed',
                suppression_reason = 'missed_slot'
          WHERE id = ANY($1) RETURNING ${SEND_CHANGE_COLUMNS}`,
        [missed],
      );
      for (const row of changed) await recordStatusChange(client, toStatusChange(row));
    }

    return { queued: toQueue.length, missed: missed.length, examined: due.length };
  });
}

/** Lookup of BullMQ job state by id, injectable for tests. */
export interface JobLookup {
  getJobState(jobId: string): Promise<string | null>;
}

export interface ReconcileOptions {
  /** Only repair dispatches whose outbox row was published at least this long ago. */
  staleMs?: number;
  limit?: number;
}

const RECONCILER_LOCK = 4_277_003;
/** BullMQ states in which the job will still run (or is running). */
const LIVE_JOB_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

/**
 * Repairs dispatches that PostgreSQL says are in flight but BullMQ no longer holds (Redis data
 * loss, a job removed by hand, a worker lost mid-claim). Each repair bumps the dispatch
 * generation and writes a fresh outbox row, so the relay enqueues a new deterministic job id. Only
 * already-due sends are ever in these states, so a repair can't send early, and the worker's
 * claim plus the slot policy still guard the actual provider call.
 */
export async function reconcileStuckDispatches(
  pool: Pool,
  jobs: JobLookup,
  options: ReconcileOptions = {},
): Promise<{ examined: number; repaired: number[] }> {
  const staleMs = options.staleMs ?? 5 * 60_000;
  const limit = options.limit ?? 500;

  const { rows: candidates } = await pool.query<{ id: number; dispatch_generation: number; dispatch_state: string }>(
    `SELECT s.id, s.dispatch_generation, s.dispatch_state
       FROM sends s
       JOIN send_outbox o ON o.send_id = s.id AND o.event_type = 'dispatch' AND o.dispatch_generation = s.dispatch_generation
      WHERE s.status = 'planned'
        AND (   (s.dispatch_state IN ('queued', 'retry_wait') AND o.published_at < now() - ($1 || ' milliseconds')::interval)
             OR (s.dispatch_state = 'claimed' AND s.claim_expires_at < now() - ($1 || ' milliseconds')::interval))
      ORDER BY s.id LIMIT $2`,
    [String(staleMs), limit],
  );

  const repaired: number[] = [];
  for (const c of candidates) {
    const state = await jobs.getJobState(dispatchJobId(c.id, c.dispatch_generation));
    if (state && LIVE_JOB_STATES.has(state)) continue;

    const done = await withTransaction(pool, async (client) => {
      // Single reconciler at a time across all dispatcher replicas.
      const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [RECONCILER_LOCK]);
      if (!lock.rows[0].ok) return false;
      const { rows } = await client.query(
        `SELECT id, campaign_id, dispatch_generation, dispatch_state, claim_expires_at < now() AS claim_expired
           FROM sends WHERE id = $1 AND status = 'planned' AND dispatch_generation = $2 AND dispatch_state = $3
           FOR UPDATE SKIP LOCKED`,
        [c.id, c.dispatch_generation, c.dispatch_state],
      );
      const send = rows[0];
      if (!send || (send.dispatch_state === 'claimed' && !send.claim_expired)) return false;
      if (send.dispatch_state === 'claimed') {
        await client.query(
          `UPDATE send_attempts SET outcome = 'lease_lost', finished_at = now(), error_message = 'reconciled: job lost while claimed'
            WHERE send_id = $1 AND outcome = 'in_progress'`,
          [c.id],
        );
      }
      const { rows: bumped } = await client.query(
        `UPDATE sends SET dispatch_state = 'queued', dispatch_generation = dispatch_generation + 1,
                claim_token = NULL, claimed_by = NULL, claim_expires_at = NULL
          WHERE id = $1 RETURNING dispatch_generation`,
        [c.id],
      );
      await insertDispatchOutbox(client, { sendId: c.id, campaignId: send.campaign_id, generation: bumped[0].dispatch_generation });
      return true;
    });
    if (done) repaired.push(c.id);
  }
  return { examined: candidates.length, repaired };
}
