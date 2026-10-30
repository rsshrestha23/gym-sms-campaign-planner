export interface SendSmsInput {
  /** Our send id, for providers that carry a reference into their callbacks. */
  sendId?: number;
  to: string;
  body: string;
  /** Stable per send (`campaign-send:<sendId>`): the provider must return the original result on reuse. */
  idempotencyKey: string;
  /** Propagated to the provider and logs for cross-system tracing. */
  correlationId: string;
}

export interface SendSmsResult {
  providerMessageId: string;
  providerRequestId?: string;
}

export interface SmsProvider {
  readonly name: string;
  /**
   * True when the provider dedupes requests by `idempotencyKey`, so an ambiguous attempt can be
   * retried safely. Defaults to true; false (e.g. Twilio's Messages API) disables blind retries
   * of ambiguous outcomes.
   */
  readonly idempotent?: boolean;
  send(input: SendSmsInput): Promise<SendSmsResult>;
  /**
   * For non-idempotent providers: finds a message the provider accepted for this input at or
   * after `since`, so an ambiguous attempt can be resolved without sending again.
   */
  findAccepted?(input: SendSmsInput, since: Date): Promise<SendSmsResult | null>;
}

/**
 * Normalized provider failure.
 * - retryable: the provider did not accept the message (5xx, refused connection, connect timeout).
 * - rate_limited: 429; wait `retryAfterMs` before any further send on this account.
 * - permanent: the provider rejected this message for good (invalid number, 4xx).
 * - ambiguous: the request may have been accepted (timeout after sending, reset mid-response).
 *   Only safe to retry with the same idempotency key, inside the provider's key-retention window.
 */
export type ProviderErrorKind = 'retryable' | 'rate_limited' | 'permanent' | 'ambiguous';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
    readonly providerRequestId?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Parses Retry-After (delta-seconds or HTTP date) into milliseconds, bounded to [1s, 10min]. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 1000), 10 * 60_000);
}

/** Masks a phone number for logs: keeps the country prefix and last two digits. */
export function maskPhone(phone: string): string {
  return phone.length <= 6 ? '***' : `${phone.slice(0, 3)}${'*'.repeat(phone.length - 5)}${phone.slice(-2)}`;
}
