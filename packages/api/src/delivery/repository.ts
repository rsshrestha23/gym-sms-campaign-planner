import { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import type { SendStatusChanged } from '../live/events';
import { DeadLetterRow, dispatchJobId, SendAttemptRow, SendJobData } from './types';

type Queryable = Pool | PoolClient;

export interface SendChangeRow {
  id: number;
  campaign_id: number;
  branch_id: number;
  status: string;
  scheduled_at: Date | null;
  updated_at: Date;
  status_version: number;
}

export function toStatusChange(row: SendChangeRow): SendStatusChanged {
  return {
    campaignId: row.campaign_id,
    sendId: row.id,
    branchId: row.branch_id,
    status: row.status as SendStatusChanged['status'],
    scheduledAt: row.scheduled_at ? row.scheduled_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
    statusVersion: row.status_version,
  };
}

/** Columns every status-changing UPDATE returns so the change can go to the status outbox. */
export const SEND_CHANGE_COLUMNS = 'id, campaign_id, branch_id, status, scheduled_at, updated_at, status_version';

/**
 * Records a committed-with-this-transaction status change for fan-out. Must be called on the same
 * client/transaction as the UPDATE that produced it; (send_id, status_version) makes it idempotent.
 */
export async function recordStatusChange(client: Queryable, change: SendStatusChanged): Promise<void> {
  await client.query(
    `INSERT INTO status_event_outbox (campaign_id, send_id, branch_id, status, status_version, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (send_id, status_version) DO NOTHING`,
    [change.campaignId, change.sendId, change.branchId, change.status, change.statusVersion, JSON.stringify(change)],
  );
}

/** Inserts the dispatch outbox row for a send that was just moved to `queued` at `generation`. */
export async function insertDispatchOutbox(
  client: Queryable,
  send: { sendId: number; campaignId: number; generation: number; traceparent?: string },
): Promise<void> {
  const payload: SendJobData = {
    sendId: send.sendId,
    campaignId: send.campaignId,
    dispatchGeneration: send.generation,
    ...(send.traceparent ? { traceparent: send.traceparent } : {}),
  };
  await client.query(
    `INSERT INTO send_outbox (send_id, event_type, dispatch_generation, job_id, payload)
     VALUES ($1, 'dispatch', $2, $3, $4)
     ON CONFLICT (send_id, event_type, dispatch_generation) DO NOTHING`,
    [send.sendId, send.generation, dispatchJobId(send.sendId, send.generation), JSON.stringify(payload)],
  );
}

export class CampaignNotFound extends Error {}

/** Operator controls and read models over the delivery tables. */
export class DeliveryRepository {
  constructor(private readonly pool: Pool) {}

  /** Enables due-send dispatch for a campaign and clears any pause. */
  async resumeCampaign(campaignId: number): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE campaigns SET dispatch_enabled = true, paused_at = NULL WHERE id = $1 AND cancelled_at IS NULL`,
      [campaignId],
    );
    if (rowCount === 0) throw new CampaignNotFound(`campaign ${campaignId} not found or cancelled`);
  }

  /** Stops new dispatches; workers also recheck this before calling the provider. */
  async pauseCampaign(campaignId: number): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE campaigns SET paused_at = COALESCE(paused_at, now()) WHERE id = $1`,
      [campaignId],
    );
    if (rowCount === 0) throw new CampaignNotFound(`campaign ${campaignId} not found`);
  }

  /**
   * Cancels a campaign: no further dispatch, and every send not yet handed to the provider becomes
   * not_scheduled (campaign_cancelled) in the same transaction, with status events for dashboards.
   * A send mid-claim finishes its in-flight provider call; queued jobs find it terminal and skip.
   */
  async cancelCampaign(campaignId: number): Promise<{ suppressed: number }> {
    return withTransaction(this.pool, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE campaigns SET cancelled_at = COALESCE(cancelled_at, now()), dispatch_enabled = false WHERE id = $1`,
        [campaignId],
      );
      if (rowCount === 0) throw new CampaignNotFound(`campaign ${campaignId} not found`);
      const { rows } = await client.query<SendChangeRow>(
        `UPDATE sends SET status = 'not_scheduled', scheduled_at = NULL, dispatch_state = 'suppressed',
                suppression_reason = 'campaign_cancelled'
          WHERE campaign_id = $1 AND status = 'planned' AND dispatch_state IN ('waiting', 'queued', 'retry_wait', 'dead_letter')
          RETURNING ${SEND_CHANGE_COLUMNS}`,
        [campaignId],
      );
      if (rows.length) {
        const changes = rows.map(toStatusChange);
        await client.query(
          `INSERT INTO status_event_outbox (campaign_id, send_id, branch_id, status, status_version, payload)
           SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::text[], $5::int[], $6::jsonb[])
           ON CONFLICT (send_id, status_version) DO NOTHING`,
          [
            changes.map((c) => c.campaignId),
            changes.map((c) => c.sendId),
            changes.map((c) => c.branchId),
            changes.map((c) => c.status),
            changes.map((c) => c.statusVersion),
            changes.map((c) => JSON.stringify(c)),
          ],
        );
      }
      return { suppressed: rows.length };
    });
  }

  async campaignControls(campaignId: number) {
    const { rows } = await this.pool.query(
      `SELECT dispatch_enabled, paused_at, cancelled_at FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    if (!rows[0]) return null;
    return {
      dispatchEnabled: rows[0].dispatch_enabled as boolean,
      pausedAt: rows[0].paused_at ? (rows[0].paused_at as Date).toISOString() : null,
      cancelledAt: rows[0].cancelled_at ? (rows[0].cancelled_at as Date).toISOString() : null,
    };
  }

  async listDeadLetters(campaignId: number, limit = 100, afterSendId = 0): Promise<DeadLetterRow[]> {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.campaign_id, s.branch_id, s.status, s.scheduled_at, s.attempt_count, s.dispatch_generation,
              (SELECT coalesce(a.error_code || ': ', '') || coalesce(a.error_message, a.outcome)
                 FROM send_attempts a WHERE a.send_id = s.id ORDER BY a.attempt_number DESC LIMIT 1) AS last_error
         FROM sends s
        WHERE s.campaign_id = $1 AND s.dispatch_state = 'dead_letter' AND s.id > $2
        ORDER BY s.id LIMIT $3`,
      [campaignId, afterSendId, limit],
    );
    return rows.map((r) => ({
      sendId: r.id,
      campaignId: r.campaign_id,
      branchId: r.branch_id,
      status: r.status,
      scheduledAt: r.scheduled_at ? r.scheduled_at.toISOString() : null,
      attemptCount: r.attempt_count,
      dispatchGeneration: r.dispatch_generation,
      lastError: r.last_error,
    }));
  }

  /**
   * Operator retry of a parked send: only possible while its public status is still `planned`
   * (e.g. an ambiguous attempt an operator verified with the provider). Creates a new dispatch
   * generation, so the BullMQ job id and outbox key are new; the provider idempotency key is not.
   */
  async retryDeadLetter(sendId: number): Promise<{ generation: number } | null> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query(
        `UPDATE sends SET dispatch_state = 'queued', dispatch_generation = dispatch_generation + 1
          WHERE id = $1 AND dispatch_state = 'dead_letter' AND status = 'planned'
          RETURNING id, campaign_id, dispatch_generation`,
        [sendId],
      );
      if (!rows[0]) return null;
      await insertDispatchOutbox(client, {
        sendId: rows[0].id,
        campaignId: rows[0].campaign_id,
        generation: rows[0].dispatch_generation,
      });
      return { generation: rows[0].dispatch_generation as number };
    });
  }

  async listAttempts(sendId: number): Promise<SendAttemptRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM send_attempts WHERE send_id = $1 ORDER BY attempt_number`,
      [sendId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      sendId: r.send_id,
      attemptNumber: r.attempt_number,
      dispatchGeneration: r.dispatch_generation,
      workerId: r.worker_id,
      outcome: r.outcome,
      providerMessageId: r.provider_message_id,
      providerRequestId: r.provider_request_id,
      errorCode: r.error_code,
      errorMessage: r.error_message,
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    }));
  }

  /**
   * Re-publishes outbox rows created at or after `since`: dispatch rows are re-enqueued (BullMQ
   * dedupes by deterministic job id; the worker's DB claim is the real guard) and status rows are
   * re-fanned out (clients dedupe by statusVersion).
   */
  async replayOutbox(since: Date): Promise<{ dispatch: number; status: number }> {
    return withTransaction(this.pool, async (client) => {
      const dispatch = await client.query(
        `UPDATE send_outbox SET published_at = NULL, lease_token = NULL, lease_expires_at = NULL, available_at = now()
          WHERE created_at >= $1 AND published_at IS NOT NULL`,
        [since],
      );
      const status = await client.query(
        `UPDATE status_event_outbox SET published_at = NULL, lease_token = NULL, lease_expires_at = NULL
          WHERE created_at >= $1 AND published_at IS NOT NULL`,
        [since],
      );
      return { dispatch: dispatch.rowCount ?? 0, status: status.rowCount ?? 0 };
    });
  }
}
