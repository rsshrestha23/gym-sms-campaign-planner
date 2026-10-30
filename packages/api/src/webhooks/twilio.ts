import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { asyncHandler, parsePositiveInt } from '../http';
import { logger } from '../observability/logger';
import { webhookRequests } from '../observability/metrics';
import type { ProviderEvent } from './provider-schema';
import { ProviderWebhookService, Receipt } from './provider-service';
import type { SigningKey } from './signature-verifier';

/**
 * X-Twilio-Signature: base64(HMAC-SHA1(authToken, fullUrl + concat(sorted POST name+value))).
 * https://www.twilio.com/docs/usage/security. The URL must be exactly what Twilio called
 * (public scheme/host, path, and query), not what the proxy forwarded. Twilio's scheme has no
 * timestamp, so replays are bounded by eventId dedupe rather than a time window.
 */
export function twilioSignature(authToken: string, url: string, params: URLSearchParams): string {
  const names = [...new Set(params.keys())].sort();
  let data = url;
  for (const name of names) for (const value of params.getAll(name)) data += name + value;
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioSignature(
  url: string,
  params: URLSearchParams,
  signature: string | undefined,
  tokens: SigningKey[],
): { ok: true; keyId: string } | { ok: false } {
  if (!signature) return { ok: false };
  const provided = Buffer.from(signature);
  for (const key of tokens) {
    const expected = Buffer.from(twilioSignature(key.secret, url, params));
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) return { ok: true, keyId: key.id };
  }
  return { ok: false };
}

/** Twilio MessageStatus values that change our send state. Others are acknowledged and ignored. */
const REPORTABLE = new Set(['sent', 'delivered', 'undelivered', 'failed']);

export interface TwilioWebhookOptions {
  /** Primary auth token first, secondary during rotation. */
  authTokens: () => SigningKey[];
  /** Public origin Twilio calls, e.g. https://webhooks.example.com (no trailing slash). */
  publicBaseUrl: string;
}

const log = logger.child({ component: 'twilio-webhook' });

/**
 * POST /webhooks/twilio?sendId=<id>: Twilio status callbacks (form-encoded). Same pipeline as
 * the generic provider webhook: durable raw receipt first, then signature, parse, and at-most-once
 * processing keyed by `${MessageSid}:${MessageStatus}`.
 */
export function twilioWebhookRoutes(service: ProviderWebhookService, options: TwilioWebhookOptions): Router {
  const router = Router();
  router.post(
    '/webhooks/twilio',
    express.raw({ type: () => true, limit: '64kb' }),
    asyncHandler(async (req, res) => {
      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const params = new URLSearchParams(raw.toString('utf8'));
      const url = `${options.publicBaseUrl}${req.originalUrl}`;
      const verdict = verifyTwilioSignature(url, params, req.get('x-twilio-signature'), options.authTokens());

      let receipt: Receipt;
      try {
        receipt = await service.recordReceipt(raw, {
          contentType: req.get('content-type'),
          authStatus: verdict.ok ? 'valid' : 'invalid',
          keyId: verdict.ok ? `twilio-${verdict.keyId}` : undefined,
          sourceIp: req.ip,
        });
      } catch (err) {
        webhookRequests.inc({ result: 'error' });
        log.error('webhook.receipt_failed', { error: (err as Error).message });
        return res.status(503).json({ error: 'receipt_unavailable', retryable: true });
      }
      if (!verdict.ok) {
        webhookRequests.inc({ result: 'invalid_signature' });
        log.warn('webhook.invalid_signature', { receiptId: receipt.id });
        return res.status(401).json({ error: 'invalid_signature', receiptId: receipt.id });
      }

      const sid = params.get('MessageSid') ?? params.get('SmsSid');
      const status = params.get('MessageStatus') ?? params.get('SmsStatus');
      const sendId = parsePositiveInt(req.query.sendId);
      if (!sid || !/^(SM|MM)[0-9a-f]{32}$/.test(sid) || !status || sendId === undefined) {
        webhookRequests.inc({ result: 'malformed' });
        return res.status(400).json({ error: 'invalid_payload', receiptId: receipt.id });
      }
      if (!REPORTABLE.has(status)) {
        webhookRequests.inc({ result: 'ignored' });
        return res.status(200).json({ result: 'ignored', reason: 'non_reportable_status', status, receiptId: receipt.id });
      }

      const event: ProviderEvent = {
        eventId: `${sid}:${status}`,
        sendId,
        status: status as ProviderEvent['status'],
        // Twilio callbacks carry no event time; use when we received it.
        occurredAt: receipt.receivedAt.toISOString(),
      };
      try {
        const outcome = await service.process(event, receipt, raw);
        webhookRequests.inc({ result: outcome.result });
        res.status(200).json({ result: outcome.result, eventId: event.eventId, receiptId: receipt.id });
      } catch (err) {
        webhookRequests.inc({ result: 'error' });
        log.error('webhook.processing_failed', { receiptId: receipt.id, error: (err as Error).message });
        res.status(503).json({ error: 'processing_failed', retryable: true, receiptId: receipt.id });
      }
    }),
  );
  return router;
}
