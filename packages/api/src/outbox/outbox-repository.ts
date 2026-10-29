import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { SendJobData } from '../delivery/types';

export interface LeasedDispatch {
  id: number;
  sendId: number;
  jobId: string;
  payload: SendJobData;
  leaseToken: string;
  publishAttempts: number;
}

/** Leased access to send_outbox rows that still need enqueuing. */
export class OutboxRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Leases up to `limit` unpublished rows. SKIP LOCKED + lease expiry let several relays run
   * concurrently, and a relay that dies mid-batch just lets its leases lapse.
   */
  async leaseDispatchBatch(limit: number, leaseMs: number): Promise<LeasedDispatch[]> {
    const token = randomUUID();
    const { rows } = await this.pool.query(
      `UPDATE send_outbox o SET lease_token = $1, lease_expires_at = now() + ($2 || ' milliseconds')::interval
        WHERE o.id IN (
          SELECT id FROM send_outbox
           WHERE published_at IS NULL AND available_at <= now()
             AND (lease_expires_at IS NULL OR lease_expires_at < now())
           ORDER BY available_at, id
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING o.id, o.send_id, o.job_id, o.payload, o.publish_attempts`,
      [token, String(leaseMs), limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      sendId: r.send_id,
      jobId: r.job_id,
      payload: r.payload,
      leaseToken: token,
      publishAttempts: r.publish_attempts,
    }));
  }

  /** Only after Redis accepted the job. A lost lease (another relay took over) is harmless. */
  async markPublished(id: number, leaseToken: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE send_outbox SET published_at = now(), lease_token = NULL, lease_expires_at = NULL,
              publish_attempts = publish_attempts + 1, last_error = NULL
        WHERE id = $1 AND lease_token = $2`,
      [id, leaseToken],
    );
    return rowCount === 1;
  }

  async markFailed(id: number, leaseToken: string, error: string, retryInMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE send_outbox SET lease_token = NULL, lease_expires_at = NULL, publish_attempts = publish_attempts + 1,
              last_error = $3, available_at = now() + ($4 || ' milliseconds')::interval
        WHERE id = $1 AND lease_token = $2`,
      [id, leaseToken, error.slice(0, 1000), String(retryInMs)],
    );
  }

  async oldestPendingAgeSeconds(): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float AS age FROM send_outbox WHERE published_at IS NULL`,
    );
    return rows[0].age;
  }
}
