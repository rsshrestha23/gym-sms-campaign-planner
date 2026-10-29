import { Pool } from 'pg';
import { withTransaction } from '../../api/src/db/pool';

const RETENTION_LOCK = 4_277_004;

export interface RetentionPolicy {
  receiptRetentionDays: number;
  attemptArchiveDays: number;
  dedupeRetentionDays: number;
  /** Provider's maximum webhook retry window: dedupe keys are never purged inside it. */
  providerRetryWindowDays: number;
}

/**
 * Creates upcoming receipt partitions and applies retention. Single runner via advisory lock.
 * Dedupe keys outlive raw receipts by design: a purged receipt only loses audit bytes, a purged
 * dedupe key could let a late provider retry apply twice.
 */
export async function runRetention(pool: Pool, policy: RetentionPolicy) {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [RETENTION_LOCK]);
    if (!rows[0].ok) return null;
    const partitions = await client.query(`SELECT ensure_provider_receipt_partitions(current_date, 3) AS n`);
    const receipts = await client.query(`SELECT drop_expired_provider_receipts(now() - ($1 || ' days')::interval) AS n`, [
      String(policy.receiptRetentionDays),
    ]);
    const attempts = await client.query(`SELECT archive_send_attempts(now() - ($1 || ' days')::interval) AS n`, [
      String(policy.attemptArchiveDays),
    ]);
    const dedupe = await client.query(
      `SELECT purge_provider_event_applications(now() - ($1 || ' days')::interval, ($2 || ' days')::interval) AS n`,
      [String(Math.max(policy.dedupeRetentionDays, policy.providerRetryWindowDays)), String(policy.providerRetryWindowDays)],
    );
    return {
      partitionsCreated: partitions.rows[0].n,
      receiptPartitionsDropped: receipts.rows[0].n,
      attemptsArchived: attempts.rows[0].n,
      dedupeKeysPurged: dedupe.rows[0].n,
    };
  });
}
