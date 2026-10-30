import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import type { SendStatusChanged } from '../live/events';
import { recordStatusChange, SEND_CHANGE_COLUMNS, toStatusChange } from './repository';
import { DEFAULT_MISSED_SLOT_GRACE_MS, slotVerdict } from './send-window';
import { providerIdempotencyKey, SendJobData } from './types';

export interface ClaimServiceOptions {
  workerId: string;
  leaseMs?: number;
  missedSlotGraceMs?: number;
  /**
   * How long the provider honours an idempotency key. After this, an ambiguous send is parked for
   * manual reconciliation instead of being retried, because a retry could deliver twice.
   */
  idempotencyWindowMs?: number;
  now?: () => Date;
}

export interface Claim {
  sendId: number;
  campaignId: number;
  branchId: number;
  leaseToken: string;
  attemptId: number;
  attemptNumber: number;
  dispatchGeneration: number;
  idempotencyKey: string;
  to: string;
  body: string;
  statusVersion: number;
}

export type ClaimResult =
  | { kind: 'claimed'; claim: Claim }
  | { kind: 'suppressed'; reason: 'opted_out_after_plan' | 'missed_slot' | 'campaign_cancelled' | 'ambiguous_window_expired'; change?: SendStatusChanged }
  | { kind: 'skip'; reason: 'terminal' | 'stale_generation' | 'claim_held' | 'not_eligible' | 'paused' | 'unknown_send' };

export type AttemptResult =
  | { outcome: 'accepted'; providerMessageId: string; providerRequestId?: string }
  | { outcome: 'permanent_error'; code: string; message: string; providerRequestId?: string }
  | { outcome: 'retryable_error' | 'rate_limited' | 'ambiguous'; code: string; message: string; providerRequestId?: string }
  /** Retries exhausted. Ambiguous exhaustion parks the send without failing it: it may have been delivered. */
  | { outcome: 'exhausted'; lastOutcome: 'retryable_error' | 'rate_limited' | 'ambiguous'; code: string; message: string };

export interface CompleteResult {
  /** False when the lease was lost (another worker reclaimed); the attempt is still recorded. */
  ownedLease: boolean;
  change?: SendStatusChanged;
}

/** Renders the campaign template; members' names are the only personal data in the body. */
export function renderMessage(template: string, vars: { firstName: string; branchName: string }): string {
  return template.replace(/\{\{(firstName|branchName)\}\}/g, (_, k: 'firstName' | 'branchName') => vars[k]);
}

/**
 * PostgreSQL claims for BullMQ workers. BullMQ delivery is at-least-once (duplicate jobs, stalled
 * job recovery, Redis repairs), so correctness lives here: a send can be claimed only while it is
 * still `planned`, matches the job's dispatch generation, and holds no unexpired lease. Consent,
 * campaign state, and the local send window are rechecked immediately before the provider call.
 */
export class ClaimService {
  readonly workerId: string;
  readonly leaseMs: number;
  private readonly graceMs: number;
  private readonly idempotencyWindowMs: number;
  private readonly now: () => Date;

  constructor(private readonly pool: Pool, options: ClaimServiceOptions) {
    this.workerId = options.workerId;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.graceMs = options.missedSlotGraceMs ?? DEFAULT_MISSED_SLOT_GRACE_MS;
    this.idempotencyWindowMs = options.idempotencyWindowMs ?? 24 * 3600_000;
    this.now = options.now ?? (() => new Date());
  }

  async claim(job: SendJobData & { jobId?: string }): Promise<ClaimResult> {
    const now = this.now();
    return withTransaction(this.pool, async (client): Promise<ClaimResult> => {
      const { rows } = await client.query(
        `SELECT s.id, s.campaign_id, s.branch_id, s.status, s.scheduled_at, s.dispatch_state, s.dispatch_generation,
                s.claim_expires_at, s.attempt_count, s.first_attempt_at, s.status_version,
                m.phone, m.name AS member_name, m.sms_opt_out,
                b.time_zone, b.name AS branch_name,
                c.dispatch_enabled, c.paused_at, c.cancelled_at, c.message_template,
                (SELECT a.outcome FROM send_attempts a WHERE a.send_id = s.id ORDER BY a.attempt_number DESC LIMIT 1) AS last_outcome
           FROM sends s
           JOIN members m ON m.id = s.member_id
           JOIN branches b ON b.id = s.branch_id
           JOIN campaigns c ON c.id = s.campaign_id
          WHERE s.id = $1
          FOR UPDATE OF s`,
        [job.sendId],
      );
      const s = rows[0];
      if (!s) return { kind: 'skip', reason: 'unknown_send' };
      if (s.status !== 'planned') return { kind: 'skip', reason: 'terminal' };
      if (s.dispatch_generation !== job.dispatchGeneration) return { kind: 'skip', reason: 'stale_generation' };
      if (s.dispatch_state === 'claimed' && s.claim_expires_at > now) return { kind: 'skip', reason: 'claim_held' };
      if (!['queued', 'retry_wait', 'claimed'].includes(s.dispatch_state)) return { kind: 'skip', reason: 'not_eligible' };

      if (s.dispatch_state === 'claimed') {
        // The previous holder's lease expired (crashed or stalled worker): close its attempt.
        await client.query(
          `UPDATE send_attempts SET outcome = 'lease_lost', finished_at = $2, error_message = 'lease expired before completion'
            WHERE send_id = $1 AND outcome = 'in_progress'`,
          [s.id, now],
        );
      }

      if (s.cancelled_at) return this.suppress(client, s.id, 'campaign_cancelled', 'not_scheduled');
      if (!s.dispatch_enabled || s.paused_at) {
        // Hand the send back to the dispatcher; it will be re-dispatched (new generation) on resume.
        await client.query(
          `UPDATE sends SET dispatch_state = 'waiting', claim_token = NULL, claimed_by = NULL, claim_expires_at = NULL WHERE id = $1`,
          [s.id],
        );
        return { kind: 'skip', reason: 'paused' };
      }
      if (s.sms_opt_out) return this.suppress(client, s.id, 'opted_out_after_plan', 'skipped_opt_out');
      if (slotVerdict(s.scheduled_at, now, s.time_zone, this.graceMs) !== 'send') {
        return this.suppress(client, s.id, 'missed_slot', 'not_scheduled');
      }
      if (
        s.last_outcome === 'ambiguous' &&
        s.first_attempt_at &&
        now.getTime() - s.first_attempt_at.getTime() > this.idempotencyWindowMs
      ) {
        await client.query(
          `UPDATE sends SET dispatch_state = 'dead_letter', claim_token = NULL, claimed_by = NULL, claim_expires_at = NULL WHERE id = $1`,
          [s.id],
        );
        return { kind: 'suppressed', reason: 'ambiguous_window_expired' };
      }

      const leaseToken = randomUUID();
      const attemptNumber = s.attempt_count + 1;
      await client.query(
        `UPDATE sends SET dispatch_state = 'claimed', claim_token = $2, claimed_by = $3,
                claim_expires_at = $4::timestamptz + ($5 || ' milliseconds')::interval,
                attempt_count = $6, first_attempt_at = COALESCE(first_attempt_at, $4)
          WHERE id = $1`,
        [s.id, leaseToken, this.workerId, now, String(this.leaseMs), attemptNumber],
      );
      const idempotencyKey = providerIdempotencyKey(s.id);
      const { rows: attempt } = await client.query(
        `INSERT INTO send_attempts (send_id, attempt_number, dispatch_generation, worker_id, lease_token, job_id, idempotency_key, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [s.id, attemptNumber, s.dispatch_generation, this.workerId, leaseToken, job.jobId ?? null, idempotencyKey, now],
      );
      return {
        kind: 'claimed',
        claim: {
          sendId: s.id,
          campaignId: s.campaign_id,
          branchId: s.branch_id,
          leaseToken,
          attemptId: Number(attempt[0].id),
          attemptNumber,
          dispatchGeneration: s.dispatch_generation,
          idempotencyKey,
          to: s.phone,
          body: renderMessage(s.message_template, {
            firstName: String(s.member_name).split(' ')[0],
            branchName: s.branch_name,
          }),
          statusVersion: s.status_version,
        },
      };
    });
  }

  private async suppress(
    client: PoolClient,
    sendId: number,
    reason: 'opted_out_after_plan' | 'missed_slot' | 'campaign_cancelled',
    status: 'skipped_opt_out' | 'not_scheduled',
  ): Promise<ClaimResult> {
    const { rows } = await client.query(
      `UPDATE sends SET status = $2,
              scheduled_at = CASE WHEN $2 = 'not_scheduled' THEN NULL ELSE scheduled_at END,
              dispatch_state = 'suppressed', suppression_reason = $3,
              claim_token = NULL, claimed_by = NULL, claim_expires_at = NULL
        WHERE id = $1 RETURNING ${SEND_CHANGE_COLUMNS}`,
      [sendId, status, reason],
    );
    const change = toStatusChange(rows[0]);
    await recordStatusChange(client, change);
    return { kind: 'suppressed', reason, change };
  }

  /**
   * Provider says the recipient has unsubscribed (e.g. replied STOP; Twilio error 21610): record
   * the opt-out so every other planned send to this member is suppressed at its own claim.
   */
  async recordProviderOptOut(sendId: number): Promise<void> {
    await this.pool.query(
      `UPDATE members SET sms_opt_out = true WHERE id = (SELECT member_id FROM sends WHERE id = $1) AND NOT sms_opt_out`,
      [sendId],
    );
  }

  /** Extends the lease during a long provider call. False means the lease was lost. */
  async heartbeat(claim: Claim): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE sends SET claim_expires_at = now() + ($3 || ' milliseconds')::interval
        WHERE id = $1 AND claim_token = $2`,
      [claim.sendId, claim.leaseToken, String(this.leaseMs)],
    );
    return rowCount === 1;
  }

  /**
   * Records the attempt and moves the send. Accepted: planned -> sent, but a final status that a
   * webhook already committed is never overwritten. The attempt row is written even if the lease
   * was lost, because the provider call really happened.
   */
  async complete(claim: Claim, result: AttemptResult): Promise<CompleteResult> {
    const now = this.now();
    return withTransaction(this.pool, async (client): Promise<CompleteResult> => {
      const outcome = result.outcome === 'exhausted' ? result.lastOutcome : result.outcome;
      await client.query(
        `UPDATE send_attempts SET outcome = $2, finished_at = $3, provider_message_id = $4, provider_request_id = $5,
                error_code = $6, error_message = $7
          WHERE id = $1 AND outcome = 'in_progress'`,
        [
          claim.attemptId,
          outcome,
          now,
          result.outcome === 'accepted' ? result.providerMessageId : null,
          'providerRequestId' in result ? (result.providerRequestId ?? null) : null,
          'code' in result ? result.code : null,
          'message' in result ? result.message.slice(0, 1000) : null,
        ],
      );

      let sql: string;
      const params: unknown[] = [claim.sendId, claim.leaseToken];
      switch (result.outcome) {
        case 'accepted':
          sql = `status = CASE WHEN status = 'planned' THEN 'sent' ELSE status END,
                 dispatch_state = 'complete', provider_message_id = $3`;
          params.push(result.providerMessageId);
          break;
        case 'permanent_error':
          sql = `status = CASE WHEN status = 'planned' THEN 'failed' ELSE status END, dispatch_state = 'complete'`;
          break;
        case 'exhausted':
          // Ambiguous: it may have been delivered, so park it for a human rather than failing it.
          sql =
            result.lastOutcome === 'ambiguous'
              ? `dispatch_state = 'dead_letter'`
              : `status = CASE WHEN status = 'planned' THEN 'failed' ELSE status END, dispatch_state = 'dead_letter'`;
          break;
        default:
          sql = `dispatch_state = 'retry_wait'`;
      }
      const { rows } = await client.query(
        `UPDATE sends SET ${sql}, claim_token = NULL, claimed_by = NULL, claim_expires_at = NULL
          WHERE id = $1 AND claim_token = $2
          RETURNING ${SEND_CHANGE_COLUMNS}`,
        params,
      );
      if (!rows[0]) return { ownedLease: false };
      const change = toStatusChange(rows[0]);
      if (change.statusVersion !== claim.statusVersion) {
        await recordStatusChange(client, change);
        return { ownedLease: true, change };
      }
      return { ownedLease: true };
    });
  }
}
