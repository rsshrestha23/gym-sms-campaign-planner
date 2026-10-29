import { Pool } from 'pg';
import { withTransaction } from '../db/pool';
import type { SendStatusChanged, SendUpdatePublisher } from '../live/events';
import type { ProviderEvent } from './provider-schema';

export type ProcessResult =
  | { result: 'applied'; update: SendStatusChanged }
  | { result: 'duplicate' }
  | { result: 'ignored'; reason: 'stale' | 'unknown_send' };

export class ProviderWebhookService {
  constructor(
    private readonly pool: Pool,
    private readonly publisher: SendUpdatePublisher,
  ) {}

  /** Commits the exact request bytes in their own transaction, before any parsing. */
  async recordReceipt(rawBody: Buffer, contentType: string | undefined): Promise<number> {
    const { rows } = await this.pool.query<{ id: number }>(
      'INSERT INTO webhook_receipts (raw_body, content_type) VALUES ($1, $2) RETURNING id',
      [rawBody, contentType ?? null],
    );
    return rows[0].id;
  }

  /**
   * Applies a valid event at most once per eventId.
   *
   * The provider_events insert claims the eventId (a concurrent duplicate blocks on the unique
   * key until this transaction ends, then sees the conflict). The conditional UPDATE re-evaluates
   * its WHERE clause under the send's row lock, so competing events for one send serialize and
   * the first committed final status wins regardless of occurredAt.
   */
  async process(event: ProviderEvent, receiptId: number): Promise<ProcessResult> {
    const outcome = await withTransaction(this.pool, async (client): Promise<ProcessResult> => {
      const claimed = await client.query(
        `INSERT INTO provider_events (event_id, receipt_id, send_id, status, occurred_at, disposition, reason)
         VALUES ($1, $2, $3, $4, $5, 'ignored', 'stale')
         ON CONFLICT (event_id) DO NOTHING`,
        [event.eventId, receiptId, event.sendId, event.status, event.occurredAt],
      );
      if (claimed.rowCount === 0) return { result: 'duplicate' };

      const { rows } = await client.query<{
        id: number;
        campaign_id: number;
        branch_id: number;
        status: SendStatusChanged['status'];
        scheduled_at: Date | null;
        updated_at: Date;
        status_version: number;
      }>(
        `UPDATE sends SET status = $2
          WHERE id = $1
            AND (   (status = 'planned' AND $2 IN ('sent', 'delivered', 'undelivered', 'failed'))
                 OR (status = 'sent'    AND $2 IN ('delivered', 'undelivered', 'failed')))
          RETURNING id, campaign_id, branch_id, status, scheduled_at, updated_at, status_version`,
        [event.sendId, event.status],
      );

      const updated = rows[0];
      if (!updated) {
        const exists = await client.query('SELECT 1 FROM sends WHERE id = $1', [event.sendId]);
        if (exists.rowCount === 0) {
          await client.query(`UPDATE provider_events SET reason = 'unknown_send' WHERE event_id = $1`, [event.eventId]);
          return { result: 'ignored', reason: 'unknown_send' };
        }
        return { result: 'ignored', reason: 'stale' };
      }

      await client.query(
        `UPDATE provider_events SET disposition = 'applied', reason = NULL WHERE event_id = $1`,
        [event.eventId],
      );
      return {
        result: 'applied',
        update: {
          campaignId: updated.campaign_id,
          sendId: updated.id,
          branchId: updated.branch_id,
          status: updated.status,
          scheduledAt: updated.scheduled_at ? updated.scheduled_at.toISOString() : null,
          updatedAt: updated.updated_at.toISOString(),
          statusVersion: updated.status_version,
        },
      };
    });

    // Only reached after COMMIT succeeded.
    if (outcome.result === 'applied') {
      try {
        this.publisher.publish(outcome.update);
      } catch (err) {
        console.error('live publish failed', err);
      }
    }
    return outcome;
  }
}
