import { Router } from 'express';
import { asyncHandler, parsePositiveInt } from '../http';
import type { CampaignRepository } from '../campaigns/repository';
import type { SseHub } from './sse-hub';

export function liveRoutes(repo: CampaignRepository, hub: SseHub): Router {
  const router = Router();

  router.get(
    '/campaigns/:id/events',
    asyncHandler(async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'invalid_campaign_id' });
      if (!(await repo.exists(id))) return res.status(404).json({ error: 'campaign_not_found' });

      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      req.socket.setNoDelay(true);

      const unsubscribe = hub.subscribe(id, res);
      // Subscribed before this frame is written, so a client that waits for `ready` before
      // fetching its snapshot cannot miss an update committed in between.
      res.write(`retry: 2000\nevent: ready\ndata: ${JSON.stringify({ campaignId: id })}\n\n`);
      req.on('close', unsubscribe);
    }),
  );

  return router;
}
