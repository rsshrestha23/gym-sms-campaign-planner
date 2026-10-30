import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import twilio from 'twilio';
import { createApp } from '../src/app';
import { CampaignRepository } from '../src/campaigns/repository';
import { parseSigningKeys } from '../src/webhooks/signature-verifier';
import { twilioSignature } from '../src/webhooks/twilio';
import { count, freshSeed, testPool } from './helpers';

const pool = testPool();
afterAll(() => pool.end());

const PRIMARY = 'twilio_primary_auth_token_0001';
const SECONDARY = 'twilio_secondary_auth_token_02';
const BASE = 'https://webhooks.example.com';
const app = createApp({
  pool,
  twilio: { authTokens: () => parseSigningKeys(`${PRIMARY},${SECONDARY}`), publicBaseUrl: BASE },
});

const SID = 'SM' + '0123456789abcdef'.repeat(2);
let sendId: number;
beforeEach(async () => {
  await freshSeed(pool);
  await new CampaignRepository(pool).plan(1);
  sendId = (await pool.query(`SELECT id FROM sends WHERE status = 'planned' ORDER BY id LIMIT 1`)).rows[0].id;
});

/** Posts a form-encoded callback signed by Twilio's own SDK, exactly as Twilio would. */
function callback(params: Record<string, string>, { token = PRIMARY, path = `/v1/webhooks/twilio?sendId=${sendId}` } = {}) {
  const signature = twilio.getExpectedTwilioSignature(token, `${BASE}${path}`, params);
  return request(app)
    .post(path)
    .set('content-type', 'application/x-www-form-urlencoded')
    .set('x-twilio-signature', signature)
    .send(new URLSearchParams(params).toString());
}

const status = (s: string) => ({ AccountSid: 'AC' + 'f'.repeat(32), MessageSid: SID, MessageStatus: s, To: '+447700000001', ApiVersion: '2010-04-01' });

describe('Twilio signature', () => {
  it('matches the official SDK, including repeated and unsorted parameters', () => {
    const url = `${BASE}/v1/webhooks/twilio?sendId=42&b=2`;
    const params = { To: '+15005550006', Body: 'Hi Zoë 👋 & welcome', MessageStatus: 'delivered', A: '' };
    const ours = twilioSignature(PRIMARY, url, new URLSearchParams(params));
    expect(ours).toBe(twilio.getExpectedTwilioSignature(PRIMARY, url, params));
    expect(twilio.validateRequest(PRIMARY, ours, url, params)).toBe(true);
  });
});

describe('POST /v1/webhooks/twilio', () => {
  it('applies a signed delivery callback and dedupes Twilio retries', async () => {
    const res = await callback(status('delivered'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: 'applied', eventId: `${SID}:delivered` });
    expect((await pool.query('SELECT status FROM sends WHERE id = $1', [sendId])).rows[0].status).toBe('delivered');
    expect((await callback(status('delivered'))).body.result).toBe('duplicate');
    // A late "sent" after the final status is acknowledged but never regresses it.
    expect((await callback(status('sent'))).body).toMatchObject({ result: 'ignored' });
    const { rows } = await pool.query(`SELECT auth_status, signature_key_id FROM provider_event_receipts ORDER BY id`);
    expect(rows).toEqual(Array(3).fill({ auth_status: 'valid', signature_key_id: 'twilio-current' }));
  });

  it('accepts the secondary auth token during rotation', async () => {
    expect((await callback(status('sent'), { token: SECONDARY })).body.result).toBe('applied');
  });

  it('acknowledges non-reportable statuses without touching state', async () => {
    for (const s of ['queued', 'accepted', 'sending', 'scheduled', 'read']) {
      const res = await callback(status(s));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ result: 'ignored', reason: 'non_reportable_status' });
    }
    expect(await count(pool, 'SELECT count(*) AS n FROM provider_event_applications')).toBe(0);
  });

  it('rejects a bad signature, a tampered sendId, and unsigned requests with 401, keeping receipts', async () => {
    const forged = await callback(status('delivered'), { token: 'not-the-token' });
    expect(forged.status).toBe(401);
    // Signature covers the query string: moving the callback to another send invalidates it.
    const signature = twilio.getExpectedTwilioSignature(PRIMARY, `${BASE}/v1/webhooks/twilio?sendId=${sendId}`, status('delivered'));
    const moved = await request(app)
      .post(`/v1/webhooks/twilio?sendId=${sendId + 1}`)
      .set('content-type', 'application/x-www-form-urlencoded')
      .set('x-twilio-signature', signature)
      .send(new URLSearchParams(status('delivered')).toString());
    expect(moved.status).toBe(401);
    expect((await request(app).post(`/v1/webhooks/twilio?sendId=${sendId}`).type('form').send(status('delivered'))).status).toBe(401);
    expect(await count(pool, `SELECT count(*) AS n FROM provider_event_receipts WHERE auth_status = 'invalid'`)).toBe(3);
    expect((await pool.query('SELECT status FROM sends WHERE id = $1', [sendId])).rows[0].status).toBe('planned');
  });

  it('rejects signed but malformed callbacks with 400', async () => {
    expect((await callback({ ...status('delivered'), MessageSid: 'nope' })).status).toBe(400);
    expect((await callback(status('delivered'), { path: '/v1/webhooks/twilio' })).status).toBe(400);
  });

  it('is not mounted unless Twilio tokens are configured', async () => {
    await request(createApp({ pool })).post('/v1/webhooks/twilio?sendId=1').type('form').send(status('sent')).expect(404);
  });
});
