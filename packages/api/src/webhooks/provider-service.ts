import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { withTransaction } from '../db/pool';
import { recordStatusChange, SEND_CHANGE_COLUMNS, toStatusChange } from '../delivery/repository';
import type { SendStatusChanged } from '../live/events';
import { sendTransitions } from '../observability/metrics';
import type { ProviderEvent } from './provider-schema';

export type ProcessResult =
  | { result: 'applied'; update: SendStatusChanged }
  /** `conflict`: the eventId was reused with a different payload; the original stands. */
  | { result: 'duplicate'; conflict: boolean }
  | { result: 'ignored'; reason: 'stale' | 'unknown_send' };

export interface Receipt {
  id: number;
  receivedAt: Date;
}

export type AuthStatus = 'valid' | 'invalid' | 'unsigned';

export class ProviderWebhookService {
  /**
   * @param afterCommit called after an applied event's transaction commits (e.g. to drain the
   *   status outbox right away); fan-out never happens inside the transaction.
   */
  constructor(
    private readonly pool: Pool,
    private readonly afterCommit: (update: SendStatusChanged) => void | Promise<void> = () => undefined,
  ) {}

  /** Commits the exact request bytes in their own transaction, before any parsing. */
  async recordReceipt(
    rawBody: Buffer,
    meta: { contentType?: string; authStatus: AuthStatus; keyId?: string; sourceIp?: string },
  ): Promise<Receipt> {
    const { rows } = await this.pool.query<{ id: string; received_at: Date }>(
      `INSERT INTO provider_event_receipts (raw_body, content_type, auth_status, signature_key_id, source_ip,
                                            retain_until)
       VALUES ($1, $2, $3, $4, $5, now() + CASE WHEN $3 = 'invalid' THEN interval '7 days' ELSE interval '90 days' END)
       RETURNING id, received_at`,
      [rawBody, meta.contentType ?? null, meta.authStatus, meta.keyId ?? null, meta.sourceIp ?? null],
    );
    return { id: Number(rows[0].id), receivedAt: rows[0].received_at };
  }

  /**
   * Applies a valid event at most once per eventId, in one transaction:
   * 1. claim the eventId in the global dedupe ledger (a concurrent duplicate blocks on the
   *    primary key until we finish, then sees the conflict);
   * 2. conditional UPDATE that rechecks the transition under the send's row lock, so competing
   *    events serialize and the first committed final status wins regardless of occurredAt;
   * 3. status outbox row for fan-out, committed with the change.
   * Events may arrive before the worker recorded `sent`: planned -> final is a legal transition.
   */
  async process(event: ProviderEvent, receipt: Receipt, rawBody: Buffer): Promise<ProcessResult> {
    const payloadHash = createHash('sha256').update(rawBody).digest();
    const outcome = await withTransaction(this.pool, async (client): Promise<ProcessResult> => {
      const claimed = await client.query(
        `INSERT INTO provider_event_applications
           (event_id, receipt_id, receipt_received_at, send_id, status, occurred_at, payload_sha256, disposition, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ignored', 'stale')
         ON CONFLICT (event_id) DO NOTHING`,
        [event.eventId, receipt.id, receipt.receivedAt, event.sendId, event.status, event.occurredAt, payloadHash],
      );
      if (claimed.rowCount === 0) {
        const { rows } = await client.query<{ same: boolean }>(
          `SELECT payload_sha256 = $2 AS same FROM provider_event_applications WHERE event_id = $1`,
          [event.eventId, payloadHash],
        );
        return { result: 'duplicate', conflict: rows[0] ? !rows[0].same : false };
      }

      const { rows } = await client.query(
        `UPDATE sends SET status = $2
          WHERE id = $1
            AND (   (status = 'planned' AND $2 IN ('sent', 'delivered', 'undelivered', 'failed'))
                 OR (status = 'sent'    AND $2 IN ('delivered', 'undelivered', 'failed')))
          RETURNING ${SEND_CHANGE_COLUMNS}`,
        [event.sendId, event.status],
      );

      if (!rows[0]) {
        const exists = await client.query('SELECT 1 FROM sends WHERE id = $1', [event.sendId]);
        if (exists.rowCount === 0) {
          await client.query(`UPDATE provider_event_applications SET reason = 'unknown_send' WHERE event_id = $1`, [event.eventId]);
          return { result: 'ignored', reason: 'unknown_send' };
        }
        return { result: 'ignored', reason: 'stale' };
      }

      const update = toStatusChange(rows[0]);
      await client.query(
        `UPDATE provider_event_applications SET disposition = 'applied', reason = NULL WHERE event_id = $1`,
        [event.eventId],
      );
      await recordStatusChange(client, update);
      return { result: 'applied', update };
    });

    if (outcome.result === 'applied') {
      sendTransitions.inc({ status: outcome.update.status, source: 'webhook' });
      try {
        await this.afterCommit(outcome.update);
      } catch (err) {
        // The change is committed and its outbox row will be relayed later; never fail the webhook.
        console.error('status fan-out after commit failed', err);
      }
    }
    return outcome;
  }
}
