import express, { Router } from 'express';
import { asyncHandler } from '../http';
import { parseProviderEvent } from './provider-schema';
import { ProviderWebhookService } from './provider-service';

export function webhookRoutes(service: ProviderWebhookService): Router {
  const router = Router();

  router.post(
    '/webhooks/provider',
    // Capture bytes for any content type so the receipt is the exact body the provider sent.
    express.raw({ type: () => true, limit: '64kb' }),
    asyncHandler(async (req, res) => {
      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      let receiptId: number;
      try {
        receiptId = await service.recordReceipt(raw, req.get('content-type'));
      } catch (err) {
        console.error('webhook receipt insert failed', err);
        return res.status(503).json({ error: 'receipt_unavailable', retryable: true });
      }

      const parsed = parseProviderEvent(raw.toString('utf8'));
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error, receiptId, issues: parsed.issues });
      }

      try {
        const outcome = await service.process(parsed.event, receiptId);
        const body: Record<string, unknown> = { result: outcome.result, eventId: parsed.event.eventId, receiptId };
        if (outcome.result === 'ignored') body.reason = outcome.reason;
        if (outcome.result === 'applied') body.statusVersion = outcome.update.statusVersion;
        res.status(200).json(body);
      } catch (err) {
        // The receipt is already committed; the event transaction rolled back, so a retry is safe.
        console.error('webhook processing failed', err);
        res.status(503).json({ error: 'processing_failed', retryable: true, receiptId });
      }
    }),
  );

  return router;
}
