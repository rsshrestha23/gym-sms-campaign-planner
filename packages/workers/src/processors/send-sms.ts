import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { AttemptResult, Claim, ClaimService } from '../../../api/src/delivery/claim-service';
import type { SendJobData } from '../../../api/src/delivery/types';
import { jobResults, providerLatency, providerResponses } from '../observability/metrics';
import { maskPhone, ProviderError, SmsProvider } from '../providers/provider';

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
    try {
      const sent = await deps.provider.send({
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
    jobResults.inc({ result: 'failed', reason: result.code });
    return { result: 'failed', reason: result.code };
  }
  if (result.outcome === 'exhausted') throw new Error('unreachable');

  // 429: back off the whole provider account without spending one of this job's attempts.
  if (result.outcome === 'rate_limited' && deps.onRateLimited) {
    await deps.claims.complete(claim, result);
    jobResults.inc({ result: 'retry', reason: 'rate_limited' });
    throw await deps.onRateLimited(retryAfterMs ?? 5_000);
  }

  const attemptsMade = job.attemptsMade + 1; // BullMQ counts this attempt only after we throw
  if (attemptsMade >= deps.maxAttempts) {
    await deps.claims.complete(claim, { outcome: 'exhausted', lastOutcome: result.outcome, code: result.code, message: result.message });
    jobResults.inc({ result: 'dead_letter', reason: result.outcome });
    return { result: 'dead_letter', reason: result.outcome };
  }
  await deps.claims.complete(claim, result);
  jobResults.inc({ result: 'retry', reason: result.outcome });
  throw new RetryableJobError(`${result.outcome}: ${result.code} ${result.message}`);
}
