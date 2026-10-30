import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { AttemptResult, Claim, ClaimService } from '../../../api/src/delivery/claim-service';
import type { SendJobData } from '../../../api/src/delivery/types';
import { jobResults, providerLatency, providerResponses } from '../observability/metrics';
import { maskPhone, ProviderError, SmsProvider } from '../providers/provider';

/** Provider error codes meaning the recipient unsubscribed (Twilio 21610: replied STOP). */
const UNSUBSCRIBED_CODES = new Set(['21610']);

/** Thrown to make BullMQ retry the job with its exponential backoff + jitter. */
export class RetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableJobError';
  }
}

export interface ProcessorDeps {
  claims: ClaimService;
  provider: SmsProvider;
  maxAttempts: number;
  heartbeatMs?: number;
  /**
   * Provider said 429: pause the whole queue (all workers on this provider account) for `ms`, and
   * return the error BullMQ should throw so the job goes back without consuming an attempt.
   */
  onRateLimited?: (ms: number) => Promise<Error>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export type ProcessResult = { result: 'sent' | 'failed' | 'dead_letter' | 'suppressed' | 'skipped'; reason?: string };

/**
 * One send attempt:
 * claim in PostgreSQL -> (heartbeat) provider call with the stable idempotency key -> record outcome.
 * Throwing schedules a BullMQ retry; returning completes the job. A duplicate or stale job fails
 * the claim and returns without calling the provider.
 */
export function createSendSmsProcessor(deps: ProcessorDeps) {
  const heartbeatMs = deps.heartbeatMs ?? Math.max(1_000, Math.floor(deps.claims.leaseMs / 3));
  const log = deps.log ?? (() => undefined);

  return async (job: Job<SendJobData>): Promise<ProcessResult> => {
    const claimed = await deps.claims.claim({ ...job.data, jobId: job.id });
    if (claimed.kind === 'skip') {
      if (claimed.reason === 'claim_held') {
        jobResults.inc({ result: 'retry', reason: 'claim_held' });
        throw new RetryableJobError('send is claimed by another worker; retry after its lease');
      }
      jobResults.inc({ result: 'skipped', reason: claimed.reason });
      return { result: 'skipped', reason: claimed.reason };
    }
    if (claimed.kind === 'suppressed') {
      jobResults.inc({ result: 'suppressed', reason: claimed.reason });
      log('send.suppressed', { sendId: job.data.sendId, reason: claimed.reason });
      return { result: 'suppressed', reason: claimed.reason };
    }

    const claim = claimed.claim;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      deps.claims.heartbeat(claim).then((ok) => { if (!ok) leaseLost = true; }, () => undefined);
    }, heartbeatMs);

    let result: AttemptResult;
    let retryAfterMs: number | undefined;
    const correlationId = randomUUID();
    const started = process.hrtime.bigint();
    const attemptStarted = new Date();
    try {
      const sent = await deps.provider.send({
        sendId: claim.sendId,
        to: claim.to,
        body: claim.body,
        idempotencyKey: claim.idempotencyKey,
        correlationId,
      });
      result = { outcome: 'accepted', providerMessageId: sent.providerMessageId, providerRequestId: sent.providerRequestId };
    } catch (err) {
      const e = err instanceof ProviderError ? err : new ProviderError('ambiguous', 'UNEXPECTED', String(err));
      retryAfterMs = e.retryAfterMs;
      const outcome = e.kind === 'permanent' ? 'permanent_error' : e.kind === 'rate_limited' ? 'rate_limited' : e.kind === 'retryable' ? 'retryable_error' : 'ambiguous';
      result = { outcome, code: e.code, message: e.message, providerRequestId: e.providerRequestId } as AttemptResult;
      if (outcome === 'ambiguous' && deps.provider.idempotent === false) {
        result = await resolveAmbiguous(deps.provider, claim, correlationId, attemptStarted, e);
        log('provider.ambiguous_lookup', { sendId: claim.sendId, found: result.outcome === 'accepted' });
      }
    } finally {
      clearInterval(heartbeat);
    }
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    providerLatency.observe({ outcome: result.outcome }, seconds);
    providerResponses.inc({ outcome: result.outcome });
    log('provider.response', {
      sendId: claim.sendId,
      attempt: claim.attemptNumber,
      outcome: result.outcome,
      to: maskPhone(claim.to),
      correlationId,
      leaseLost,
      ms: Math.round(seconds * 1000),
    });

    return finish(deps, job, claim, result, retryAfterMs);
  };
}

/**
 * A non-idempotent provider (Twilio) may have created the message even though we saw an error.
 * Retrying could text the member twice, so look it up instead: found -> it was sent; not found
 * (or the lookup itself fails) -> park in dead_letter, still `planned`, for an operator.
 */
async function resolveAmbiguous(
  provider: SmsProvider,
  claim: Claim,
  correlationId: string,
  since: Date,
  error: ProviderError,
): Promise<AttemptResult> {
  const input = { sendId: claim.sendId, to: claim.to, body: claim.body, idempotencyKey: claim.idempotencyKey, correlationId };
  try {
    const found = await provider.findAccepted?.(input, since);
    if (found) return { outcome: 'accepted', providerMessageId: found.providerMessageId, providerRequestId: error.providerRequestId };
  } catch {
    // fall through: unknown stays unknown
  }
  return {
    outcome: 'exhausted',
    lastOutcome: 'ambiguous',
    code: error.code,
    message: `${error.message}; not found by provider lookup and the provider is not idempotent, so not retried`,
  };
}

async function finish(
  deps: ProcessorDeps,
  job: Job<SendJobData>,
  claim: Claim,
  result: AttemptResult,
  retryAfterMs: number | undefined,
): Promise<ProcessResult> {
  if (result.outcome === 'accepted') {
    await deps.claims.complete(claim, result);
    jobResults.inc({ result: 'sent', reason: '' });
    return { result: 'sent' };
  }
  if (result.outcome === 'permanent_error') {
    await deps.claims.complete(claim, result);
    if (UNSUBSCRIBED_CODES.has(result.code)) await deps.claims.recordProviderOptOut(claim.sendId);
    jobResults.inc({ result: 'failed', reason: result.code });
    return { result: 'failed', reason: result.code };
  }
  if (result.outcome === 'exhausted') {
    await deps.claims.complete(claim, result);
    jobResults.inc({ result: 'dead_letter', reason: result.lastOutcome });
    return { result: 'dead_letter', reason: result.lastOutcome };
  }

  // 429: back off the whole provider account without spending one of this job's attempts.
  if (result.outcome === 'rate_limited' && deps.onRateLimited) {
    await deps.claims.complete(claim, result);
    jobResults.inc({ result: 'retry', reason: 'rate_limited' });
    throw await deps.onRateLimited(retryAfterMs ?? 5_000);
  }

  const attemptsMade = job.attemptsMade + 1; // BullMQ counts this attempt only after we throw
  // The job's own limit wins: if BullMQ won't retry, PostgreSQL must not be left in retry_wait.
  const maxAttempts = job.opts?.attempts ?? deps.maxAttempts;
  if (attemptsMade >= maxAttempts) {
    await deps.claims.complete(claim, { outcome: 'exhausted', lastOutcome: result.outcome, code: result.code, message: result.message });
    jobResults.inc({ result: 'dead_letter', reason: result.outcome });
    return { result: 'dead_letter', reason: result.outcome };
  }
  await deps.claims.complete(claim, result);
  jobResults.inc({ result: 'retry', reason: result.outcome });
  throw new RetryableJobError(`${result.outcome}: ${result.code} ${result.message}`);
}
