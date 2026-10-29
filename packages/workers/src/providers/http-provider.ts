import { ProviderError, parseRetryAfter, SendSmsInput, SendSmsResult, SmsProvider } from './provider';

export interface HttpProviderOptions {
  /** HTTPS endpoint that accepts { to, body } and honours the Idempotency-Key header. */
  url: string;
  apiKey: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/** undici error codes raised before the request could have reached the provider. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET_BEFORE_SEND']);

/**
 * Generic HTTPS provider adapter. A concrete vendor adapter (once one is selected) keeps this
 * classification and swaps the request/response mapping.
 */
export class HttpSmsProvider implements SmsProvider {
  readonly name = 'http';
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpProviderOptions) {
    if (!/^https:\/\//.test(options.url) && !/^http:\/\/(localhost|127\.0\.0\.1|mock-provider)(:|\/)/.test(options.url)) {
      throw new Error('SMS provider URL must use https (plain http is only allowed for a local mock)');
    }
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    let res: Response;
    try {
      res = await this.fetchFn(this.options.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': input.idempotencyKey,
          'x-correlation-id': input.correlationId,
        },
        // clientReference lets delivery callbacks be correlated back to the send.
        body: JSON.stringify({ to: input.to, body: input.body, clientReference: input.idempotencyKey }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const code = errorCode(err);
      if (NOT_SENT_CODES.has(code)) throw new ProviderError('retryable', code, `provider unreachable (${code})`);
      // Timed out or reset after the request may have been written: we cannot know if it was accepted.
      throw new ProviderError('ambiguous', code, `provider outcome unknown (${code})`);
    }

    const requestId = res.headers.get('x-request-id') ?? undefined;
    const text = await res.text().catch(() => '');
    if (res.ok) {
      let id: unknown;
      try {
        id = (JSON.parse(text) as { id?: unknown }).id;
      } catch {
        id = undefined;
      }
      if (typeof id !== 'string' || !id) {
        throw new ProviderError('ambiguous', 'bad_response', 'provider accepted without a message id', undefined, requestId);
      }
      return { providerMessageId: id, providerRequestId: requestId };
    }
    const detail = `HTTP ${res.status}`;
    if (res.status === 429) {
      throw new ProviderError('rate_limited', '429', detail, parseRetryAfter(res.headers.get('retry-after')) ?? 5_000, requestId);
    }
    if (res.status === 504) throw new ProviderError('ambiguous', '504', detail, undefined, requestId);
    if (res.status === 408 || res.status >= 500) {
      throw new ProviderError('retryable', String(res.status), detail, parseRetryAfter(res.headers.get('retry-after')), requestId);
    }
    throw new ProviderError('permanent', String(res.status), detail, undefined, requestId);
  }
}

function errorCode(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'TIMEOUT';
  return e?.cause?.code ?? e?.code ?? e?.cause?.name ?? 'NETWORK_ERROR';
}
