import { ProviderError, parseRetryAfter, SendSmsInput, SendSmsResult, SmsProvider } from './provider';

export interface TwilioProviderOptions {
  accountSid: string;
  /** Auth token, or an API key secret when `apiKeySid` is set (preferred: revocable per service). */
  authToken: string;
  apiKeySid?: string;
  /** Exactly one of these: a sender number, or a Messaging Service (sender pool, compliance). */
  from?: string;
  messagingServiceSid?: string;
  /** Public base URL of our webhook, e.g. https://webhooks.example.com/v1/webhooks/twilio */
  statusCallbackUrl?: string;
  timeoutMs?: number;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
  /** Wait before looking up an ambiguous send, so a just-created message is visible. */
  lookupDelayMs?: number;
}

/** Twilio error codes that are final for this message (https://www.twilio.com/docs/api/errors). */
const PERMANENT_TWILIO_CODES = new Set([21211, 21214, 21217, 21408, 21606, 21610, 21612, 21614, 30003, 30004, 30005, 30006, 30007]);
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Twilio Programmable Messaging adapter (POST /2010-04-01/Accounts/{sid}/Messages.json).
 *
 * Twilio's Messages API has no idempotency key, so `idempotent = false`: the worker never retries
 * an ambiguous outcome blindly. It calls `findAccepted`, which lists recent messages to this
 * recipient and matches the exact body created since the attempt started; a match is recorded
 * as sent, no match parks the send for manual reconciliation. Errors that prove the message was
 * not created (connection refused, 429, 5xx with a Twilio error body) are retried normally.
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  readonly idempotent = false;
  private readonly base: string;
  private readonly auth: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: TwilioProviderOptions) {
    if (!options.from === !options.messagingServiceSid) {
      throw new Error('Twilio needs exactly one of TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID');
    }
    this.base = `${options.apiBaseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}`;
    this.auth = `Basic ${Buffer.from(`${options.apiKeySid ?? options.accountSid}:${options.authToken}`).toString('base64')}`;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const form = new URLSearchParams({ To: input.to, Body: input.body });
    if (this.options.messagingServiceSid) form.set('MessagingServiceSid', this.options.messagingServiceSid);
    else form.set('From', this.options.from!);
    if (this.options.statusCallbackUrl && input.sendId !== undefined) {
      // sendId rides in the callback URL (it is covered by X-Twilio-Signature).
      const cb = new URL(this.options.statusCallbackUrl);
      cb.searchParams.set('sendId', String(input.sendId));
      form.set('StatusCallback', cb.toString());
    }

    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: this.auth,
          'content-type': 'application/x-www-form-urlencoded',
          'x-correlation-id': input.correlationId,
        },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (err) {
      const code = errorCode(err);
      if (NOT_SENT_CODES.has(code)) throw new ProviderError('retryable', code, `Twilio unreachable (${code})`);
      throw new ProviderError('ambiguous', code, `Twilio outcome unknown (${code})`);
    }

    const requestId = res.headers.get('twilio-request-id') ?? undefined;
    const body = (await res.json().catch(() => null)) as { sid?: string; code?: number; message?: string } | null;
    if (res.status === 201 || res.status === 200) {
      if (!body?.sid) throw new ProviderError('ambiguous', 'bad_response', 'Twilio accepted without a message sid', undefined, requestId);
      return { providerMessageId: body.sid, providerRequestId: requestId };
    }
    const code = body?.code ? String(body.code) : String(res.status);
    const detail = `HTTP ${res.status}${body?.code ? ` Twilio ${body.code}` : ''}: ${body?.message ?? ''}`.trim();
    if (res.status === 429 || body?.code === 20429) {
      throw new ProviderError('rate_limited', code, detail, parseRetryAfter(res.headers.get('retry-after')) ?? 1_000, requestId);
    }
    if (body?.code && PERMANENT_TWILIO_CODES.has(body.code)) throw new ProviderError('permanent', code, detail, undefined, requestId);
    // A structured Twilio error on 5xx means the API answered and rejected the request.
    if (res.status >= 500) throw new ProviderError(body?.code ? 'retryable' : 'ambiguous', code, detail, undefined, requestId);
    throw new ProviderError('permanent', code, detail, undefined, requestId);
  }

  async findAccepted(input: SendSmsInput, since: Date): Promise<SendSmsResult | null> {
    await new Promise((r) => setTimeout(r, this.options.lookupDelayMs ?? 2_000));
    const query = new URLSearchParams({ To: input.to, PageSize: '50' });
    if (this.options.from) query.set('From', this.options.from);
    const res = await this.fetchFn(`${this.base}/Messages.json?${query}`, {
      headers: { authorization: this.auth },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new ProviderError('ambiguous', String(res.status), `Twilio lookup failed: HTTP ${res.status}`);
    const page = (await res.json()) as { messages?: { sid: string; body: string; date_created: string; direction: string }[] };
    const skewMs = 60_000; // tolerate clock skew between us and Twilio
    const match = (page.messages ?? []).find(
      (m) => m.direction?.startsWith('outbound') && m.body === input.body && Date.parse(m.date_created) >= since.getTime() - skewMs,
    );
    return match ? { providerMessageId: match.sid } : null;
  }
}

function errorCode(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'TIMEOUT';
  return e?.cause?.code ?? e?.code ?? 'NETWORK_ERROR';
}
