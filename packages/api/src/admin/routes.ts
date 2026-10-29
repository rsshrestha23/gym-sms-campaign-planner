import { timingSafeEqual } from 'node:crypto';
import { RequestHandler, Router } from 'express';
import type { Pool } from 'pg';
import { CampaignNotFound, DeliveryRepository } from '../delivery/repository';
import { asyncHandler, parsePositiveInt } from '../http';
import { reconcileStatusCounts } from '../live/status-projection';
import { logger } from '../observability/logger';

/** Optional BullMQ queue controls, present when the API is configured with Redis. */
export interface QueueControl {
  pause(): Promise<void>;
  resume(): Promise<void>;
  counts(): Promise<Record<string, number>>;
}

function requireAdmin(token: string): RequestHandler {
  const expected = Buffer.from(token);
  return (req, res, next) => {
    const provided = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer /, ''));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

/**
 * Operator controls under /v1/admin, bearer-token protected (and expected to be reachable only
 * from the internal network / via the admin ingress). Disabled entirely without ADMIN_API_TOKEN.
 */
export function adminRoutes(pool: Pool, token: string, queue?: QueueControl): Router {
  const router = Router();
  const delivery = new DeliveryRepository(pool);
  const audit = logger.child({ component: 'admin' });
  router.use('/admin', requireAdmin(token));

  const campaignAction = (path: string, action: (id: number) => Promise<unknown>) =>
    router.post(
      path,
      asyncHandler(async (req, res) => {
        const id = parsePositiveInt(req.params.id);
        if (id === undefined) return res.status(400).json({ error: 'invalid_campaign_id' });
        try {
          await action(id);
        } catch (err) {
          if (err instanceof CampaignNotFound) return res.status(404).json({ error: 'campaign_not_found' });
          throw err;
        }
        audit.info('admin.action', { path: req.path, campaignId: id });
        res.json({ campaignId: id, ...(await delivery.campaignControls(id)) });
      }),
    );

  campaignAction('/admin/campaigns/:id/dispatch/resume', (id) => delivery.resumeCampaign(id));
  campaignAction('/admin/campaigns/:id/dispatch/pause', (id) => delivery.pauseCampaign(id));
  campaignAction('/admin/campaigns/:id/cancel', (id) => delivery.cancelCampaign(id));

  router.get(
    '/admin/campaigns/:id/dead-letters',
    asyncHandler(async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'invalid_campaign_id' });
      const after = parsePositiveInt(req.query.after) ?? 0;
      res.json({ items: await delivery.listDeadLetters(id, 100, after) });
    }),
  );

  router.post(
    '/admin/sends/:id/retry',
    asyncHandler(async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'invalid_send_id' });
      const retried = await delivery.retryDeadLetter(id);
      if (!retried) return res.status(409).json({ error: 'not_retryable', detail: 'only dead-lettered sends still planned can be retried' });
      audit.info('admin.retry_dead_letter', { sendId: id, generation: retried.generation });
      res.json({ sendId: id, dispatchGeneration: retried.generation });
    }),
  );

  router.get(
    '/admin/sends/:id/attempts',
    asyncHandler(async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'invalid_send_id' });
      res.json({ items: await delivery.listAttempts(id) });
    }),
  );

  router.post(
    '/admin/outbox/replay',
    asyncHandler(async (req, res) => {
      const since = new Date(String(req.body?.since ?? ''));
      if (Number.isNaN(since.getTime())) return res.status(400).json({ error: 'since must be an ISO-8601 timestamp' });
      const replayed = await delivery.replayOutbox(since);
      audit.info('admin.outbox_replay', { since: since.toISOString(), ...replayed });
      res.json(replayed);
    }),
  );

  router.post(
    '/admin/campaigns/:id/status-counts/reconcile',
    asyncHandler(async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'invalid_campaign_id' });
      res.json({ drift: await reconcileStatusCounts(pool, id) });
    }),
  );

  router.get(
    '/admin/queue',
    asyncHandler(async (_req, res) => {
      if (!queue) return res.status(404).json({ error: 'queue_not_configured' });
      res.json(await queue.counts());
    }),
  );
  router.post(
    '/admin/queue/pause',
    asyncHandler(async (_req, res) => {
      if (!queue) return res.status(404).json({ error: 'queue_not_configured' });
      await queue.pause(); // drain: workers finish in-flight jobs, take no new ones
      audit.info('admin.queue_pause', {});
      res.json(await queue.counts());
    }),
  );
  router.post(
    '/admin/queue/resume',
    asyncHandler(async (_req, res) => {
      if (!queue) return res.status(404).json({ error: 'queue_not_configured' });
      await queue.resume();
      audit.info('admin.queue_resume', {});
      res.json(await queue.counts());
    }),
  );

  return router;
}
