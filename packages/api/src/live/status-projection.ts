import { Pool } from 'pg';

export interface CountDrift {
  branchId: number;
  status: string;
  projected: number;
  actual: number;
}

/**
 * Branch/status counters are maintained transactionally by statement-level triggers on sends
 * (migration 004), so they are exact by construction. This compares them with the canonical
 * sends table, repairs any drift (e.g. after a manual data fix with triggers disabled), and
 * returns what it fixed so the job can alert on non-empty results.
 */
export async function reconcileStatusCounts(pool: Pool, campaignId: number): Promise<CountDrift[]> {
  const { rows } = await pool.query(`SELECT * FROM reconcile_status_counts($1)`, [campaignId]);
  return rows.map((r) => ({ branchId: r.branch_id, status: r.status, projected: Number(r.projected), actual: Number(r.actual) }));
}

/** Reconciles every planned campaign; meant to run on a schedule (e.g. every 15 minutes). */
export async function reconcileAllStatusCounts(pool: Pool): Promise<Record<number, CountDrift[]>> {
  const { rows } = await pool.query<{ id: number }>(`SELECT id FROM campaigns WHERE planned_at IS NOT NULL ORDER BY id`);
  const out: Record<number, CountDrift[]> = {};
  for (const { id } of rows) {
    const drift = await reconcileStatusCounts(pool, id);
    if (drift.length) out[id] = drift;
  }
  return out;
}
