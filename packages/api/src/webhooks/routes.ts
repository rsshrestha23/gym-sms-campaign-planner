import express, { Router } from 'express';
import { asyncHandler } from '../http';
import { logger } from '../observability/logger';
import { webhookRequests } from '../observability/metrics';
import { parseProviderEvent } from './provider-schema';
import { AuthStatus, ProviderWebhookService, Receipt } from './provider-service';
import { tokenBucket } from './rate-limit';
import { SIGNATURE_HEADER, SigningKey, TIMESTAMP_HEADER, verifySignature } from './signature-verifier';

export interface WebhookOptions {
  /**
   * Newest first; a function lets the server swap keys on rotation without a restart. Empty
   * disables verification (local demo only; refused by the production config).
   */
  signingKeys?: SigningKey[] | (() => SigningKey[]);
  toleranceSec?: number;
  /** Per-instance limit; off unless configured (the server enables it from env). */
  rateLimit?: { ratePerSecond: number; burst: number };
}

const log = logger.child({ component: 'webhook' });

/**
 * POST /webhooks/provider. Order of work, cheapest first:
 * rate limit -> durable raw receipt (with its auth result) -> signature -> parse -> process.
 * Responses: 200 applied/duplicate/ignored; 400 malformed; 401 bad signature; 429 rate limited;
 * 503 when the receipt or the event transaction failed (the provider should retry).
 */
export function webhookRoutes(service: ProviderWebhookService, options: WebhookOptions = {}): Router {
  const router = Router();
  const signingKeys = options.signingKeys ?? [];
  const currentKeys = typeof signingKeys === 'function' ? signingKeys : () => signingKeys;
  const limiter = options.rateLimit
    ? tokenBucket({ ...options.rateLimit, onLimited: () => webhookRequests.inc({ result: 'rate_limited' }) })
    : undefined;

  router.post(
    '/webhooks/provider',
    ...(limiter ? [limiter] : []),
    // Capture bytes for any content type so the receipt is the exact body the provider sent.
    express.raw({ type: () => true, limit: '64kb' }),
    asyncHandler(async (req, res) => {
      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      let auth: AuthStatus = 'unsigned';
      let keyId: string | undefined;
      let authFailure: string | undefined;
      const keys = currentKeys();
      if (keys.length) {
        const verdict = verifySignature(
          raw,
          { signature: req.get(SIGNATURE_HEADER), timestamp: req.get(TIMESTAMP_HEADER) },
          keys,
          { toleranceSec: options.toleranceSec },
        );
        auth = verdict.ok ? 'valid' : 'invalid';
        keyId = verdict.ok ? verdict.keyId : undefined;
        authFailure = verdict.ok ? undefined : verdict.reason;
      }

      let receipt: Receipt;
      try {
        receipt = await service.recordReceipt(raw, {
          contentType: req.get('content-type'),
          authStatus: auth,
          keyId,
          sourceIp: req.ip,
        });
      } catch (err) {
        webhookRequests.inc({ result: 'error' });
        log.error('webhook.receipt_failed', { error: (err as Error).message });
        return res.status(503).json({ error: 'receipt_unavailable', retryable: true });
      }

      if (auth === 'invalid') {
        webhookRequests.inc({ result: 'invalid_signature' });
        log.warn('webhook.invalid_signature', { receiptId: receipt.id, reason: authFailure });
        return res.status(401).json({ error: 'invalid_signature', reason: authFailure, receiptId: receipt.id });
      }

      const parsed = parseProviderEvent(raw.toString('utf8'));
      if (!parsed.ok) {
        webhookRequests.inc({ result: 'malformed' });
        return res.status(400).json({ error: parsed.error, receiptId: receipt.id, issues: parsed.issues });
      }

      try {
        const outcome = await service.process(parsed.event, receipt, raw);
        webhookRequests.inc({ result: outcome.result });
        const body: Record<string, unknown> = { result: outcome.result, eventId: parsed.event.eventId, receiptId: receipt.id };
        if (outcome.result === 'ignored') body.reason = outcome.reason;
        if (outcome.result === 'applied') body.statusVersion = outcome.update.statusVersion;
        if (outcome.result === 'duplicate' && outcome.conflict) {
          body.conflict = true;
          log.warn('webhook.event_id_reused_with_different_payload', { eventId: parsed.event.eventId, receiptId: receipt.id });
        }
        res.status(200).json(body);
      } catch (err) {
        // The receipt is already committed; the event transaction rolled back, so a retry is safe.
        webhookRequests.inc({ result: 'error' });
        log.error('webhook.processing_failed', { receiptId: receipt.id, error: (err as Error).message });
        res.status(503).json({ error: 'processing_failed', retryable: true, receiptId: receipt.id });
      }
    }),
  );

  return router;
}
