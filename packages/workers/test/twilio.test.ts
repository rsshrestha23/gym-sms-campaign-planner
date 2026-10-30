import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { CampaignRepository } from '../../api/src/campaigns/repository';
import { ClaimService } from '../../api/src/delivery/claim-service';
import type { SendJobData } from '../../api/src/delivery/types';
import { freshSeed, testPool } from '../../api/test/helpers';
import { createSendSmsProcessor } from '../src/processors/send-sms';
import { ProviderError } from '../src/providers/provider';
import { TwilioSmsProvider } from '../src/providers/twilio-provider';

process.env.LOG_LEVEL = 'silent';
const SID = 'SM' + 'a'.repeat(32);
const input = { sendId: 7, to: '+447700000001', body: 'Hi Amelia', idempotencyKey: 'campaign-send:7', correlationId: 'c-1' };

/** A fake Twilio REST API: records requests and answers from a script. */
function fakeTwilio(answers: (Response | Error)[], lookup: object[] = []) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let lastBody = '';
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (!init?.method) {
      // '$SENT' stands for the body of the last message we POSTed.
      const messages = lookup.map((m: any) => (m.body === '$SENT' ? { ...m, body: lastBody } : m));
      return new Response(JSON.stringify({ messages }), { status: 200 });
    }
    lastBody = new URLSearchParams(String(init.body)).get('Body') ?? '';
    const next = answers.shift() ?? new Response(JSON.stringify({ sid: SID }), { status: 201 });
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  const provider = new TwilioSmsProvider({
    accountSid: 'AC' + '1'.repeat(32), authToken: 'tok', messagingServiceSid: 'MG' + '2'.repeat(32),
    statusCallbackUrl: 'https://webhooks.example.com/v1/webhooks/twilio', fetchFn, lookupDelayMs: 0,
  });
  return { provider, calls };
}
const twilioError = (status: number, code: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ code, message: `error ${code}`, status }), { status, headers });

describe('TwilioSmsProvider', () => {
  it('creates a message with the messaging service and a signed-URL status callback carrying sendId', async () => {
    const { provider, calls } = fakeTwilio([]);
    expect(await provider.send(input)).toEqual({ providerMessageId: SID, providerRequestId: undefined });
    expect(provider.idempotent).toBe(false);
    const { url, init } = calls[0];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/AC${'1'.repeat(32)}/Messages.json`);
    expect(new Headers(init!.headers).get('authorization')).toBe(`Basic ${Buffer.from(`AC${'1'.repeat(32)}:tok`).toString('base64')}`);
    const form = new URLSearchParams(String(init!.body));
    expect(Object.fromEntries(form)).toEqual({
      To: '+447700000001', Body: 'Hi Amelia', MessagingServiceSid: 'MG' + '2'.repeat(32),
      StatusCallback: 'https://webhooks.example.com/v1/webhooks/twilio?sendId=7',
    });
  });

  it('classifies Twilio failures', async () => {
    const kind = async (answer: Response | Error) =>
      fakeTwilio([answer]).provider.send(input).then(() => 'accepted', (e: ProviderError) => [e.kind, e.code]);
    expect(await kind(twilioError(429, 20429, { 'retry-after': '2' }))).toEqual(['rate_limited', '20429']);
    expect(await kind(twilioError(400, 21211))).toEqual(['permanent', '21211']); // invalid To
    expect(await kind(twilioError(400, 21610))).toEqual(['permanent', '21610']); // recipient replied STOP
    expect(await kind(twilioError(503, 20500))).toEqual(['retryable', '20500']); // Twilio answered: not created
    expect(await kind(new Response('<html>bad gateway</html>', { status: 502 }))).toEqual(['ambiguous', '502']);
    expect(await kind(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toEqual(['ambiguous', 'TIMEOUT']);
    expect(await kind(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toEqual(['retryable', 'ECONNREFUSED']);
  });

  it('finds an accepted message by recipient, exact body, and time', async () => {
    const since = new Date('2026-10-30T10:00:00Z');
    const { provider } = fakeTwilio([], [
      { sid: 'SMold', body: 'Hi Amelia', direction: 'outbound-api', date_created: 'Thu, 29 Oct 2026 10:00:00 +0000' },
      { sid: 'SMother', body: 'Different text', direction: 'outbound-api', date_created: 'Fri, 30 Oct 2026 10:00:05 +0000' },
      { sid: 'SMmatch', body: 'Hi Amelia', direction: 'outbound-api', date_created: 'Fri, 30 Oct 2026 10:00:03 +0000' },
    ]);
    expect(await provider.findAccepted(input, since)).toEqual({ providerMessageId: 'SMmatch' });
    expect(await fakeTwilio([], []).provider.findAccepted(input, since)).toBeNull();
  });
});

describe('send processor with a non-idempotent provider (Twilio)', () => {
  const pool = testPool();
  afterAll(() => pool.end());
  const SLOT = new Date('2026-10-23T08:00:00Z');
  const claims = new ClaimService(pool, { workerId: 'w', now: () => new Date(SLOT.getTime() + 60_000), idempotencyWindowMs: 0 });
  let sendId: number;
  const job = () => ({ id: 'j', data: { sendId, campaignId: 1, dispatchGeneration: 1 }, attemptsMade: 0 }) as Job<SendJobData>;
  const row = async () => (await pool.query('SELECT status, dispatch_state, provider_message_id FROM sends WHERE id = $1', [sendId])).rows[0];
  const posts = (calls: { init?: RequestInit }[]) => calls.filter((c) => c.init?.method === 'POST').length;

  beforeEach(async () => {
    await freshSeed(pool);
    await new CampaignRepository(pool).plan(1);
    await pool.query('UPDATE campaigns SET dispatch_enabled = true WHERE id = 1');
    sendId = (await pool.query('SELECT id FROM sends WHERE member_id = 1')).rows[0].id;
    await pool.query(`UPDATE sends SET dispatch_state = 'queued', dispatch_generation = 1 WHERE id = $1`, [sendId]);
  });

  it('resolves an ambiguous send by lookup instead of sending again', async () => {
    const { provider, calls } = fakeTwilio([Object.assign(new Error('t'), { name: 'TimeoutError' })], [
      { sid: SID, body: '$SENT', direction: 'outbound-api', date_created: new Date().toUTCString() },
    ]);
    expect(await createSendSmsProcessor({ claims, provider, maxAttempts: 5 })(job())).toEqual({ result: 'sent' });
    expect(posts(calls)).toBe(1);
    expect(await row()).toMatchObject({ status: 'sent', dispatch_state: 'complete', provider_message_id: SID });
  });

  it('parks an unresolved ambiguous send without retrying it', async () => {
    const { provider, calls } = fakeTwilio([new Response('upstream reset', { status: 502 })], []);
    expect(await createSendSmsProcessor({ claims, provider, maxAttempts: 5 })(job())).toEqual({ result: 'dead_letter', reason: 'ambiguous' });
    expect(posts(calls)).toBe(1);
    expect(await row()).toMatchObject({ status: 'planned', dispatch_state: 'dead_letter' });
    const { rows } = await pool.query(`SELECT outcome, error_message FROM send_attempts WHERE send_id = $1`, [sendId]);
    expect(rows[0].outcome).toBe('ambiguous');
    expect(rows[0].error_message).toMatch(/not found by provider lookup/);
  });

  it('records a STOP (21610) as a member opt-out', async () => {
    const { provider } = fakeTwilio([twilioError(400, 21610)]);
    expect(await createSendSmsProcessor({ claims, provider, maxAttempts: 5 })(job())).toEqual({ result: 'failed', reason: '21610' });
    expect((await pool.query('SELECT sms_opt_out FROM members WHERE id = 1')).rows[0].sms_opt_out).toBe(true);
  });

  it('still retries failures that prove nothing was created', async () => {
    const { provider } = fakeTwilio([twilioError(503, 20500)]);
    await expect(createSendSmsProcessor({ claims, provider, maxAttempts: 5 })(job())).rejects.toThrow(/retryable_error/);
    expect(await row()).toMatchObject({ status: 'planned', dispatch_state: 'retry_wait' });
  });
});
