import type { SendStatus } from '../sends/status-transition';

export const DISPATCH_STATES = ['waiting', 'queued', 'claimed', 'retry_wait', 'suppressed', 'complete', 'dead_letter'] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

export const ATTEMPT_OUTCOMES = [
  'in_progress', 'accepted', 'retryable_error', 'rate_limited', 'permanent_error', 'ambiguous',
  'suppressed', 'lease_lost', 'abandoned',
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export type SuppressionReason = 'opted_out_after_plan' | 'missed_slot' | 'campaign_cancelled';

/** BullMQ job payload. Everything else is re-read from PostgreSQL by the worker. */
export interface SendJobData {
  sendId: number;
  campaignId: number;
  dispatchGeneration: number;
  /** W3C traceparent of the dispatch, so worker spans join the dispatcher's trace. */
  traceparent?: string;
}

/** Stable per-send key sent to the provider on every attempt of every generation. */
export const providerIdempotencyKey = (sendId: number): string => `campaign-send:${sendId}`;

/**
 * Deterministic BullMQ job id per dispatch generation. BullMQ rejects ':' in custom ids (outside a
 * legacy 3-part form slated for removal), so this uses '-' rather than the plan's `send:<id>:<gen>`.
 */
export const dispatchJobId = (sendId: number, generation: number): string => `send-${sendId}-${generation}`;

export interface SendAttemptRow {
  id: number;
  sendId: number;
  attemptNumber: number;
  dispatchGeneration: number;
  workerId: string;
  outcome: AttemptOutcome;
  providerMessageId: string | null;
  providerRequestId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface DeadLetterRow {
  sendId: number;
  campaignId: number;
  branchId: number;
  status: SendStatus;
  scheduledAt: string | null;
  attemptCount: number;
  dispatchGeneration: number;
  lastError: string | null;
}

/**
 * One BullMQ queue per provider account, so BullMQ's queue-wide limiter enforces that account's
 * rate limit across every worker process sharing it.
 */
export function smsQueueName(providerAccount: string): string {
  return `sms-send.${providerAccount.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}
