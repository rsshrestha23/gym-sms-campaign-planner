import express, { ErrorRequestHandler, Express } from 'express';
import { Pool } from 'pg';
import { CampaignRepository } from './campaigns/repository';
import { campaignRoutes } from './campaigns/routes';
import { noopPublisher, SendUpdatePublisher } from './live/events';
import { liveRoutes } from './live/routes';
import { SseHub } from './live/sse-hub';
import { ProviderWebhookService } from './webhooks/provider-service';
import { webhookRoutes } from './webhooks/routes';
import { mountVersions } from './versioning';

export interface AppDeps {
  pool: Pool;
  /** SSE hub for GET /v1/campaigns/:id/events; also the publisher unless one is passed explicitly. */
  hub?: SseHub;
  publisher?: SendUpdatePublisher;
}

export function createApp({ pool, hub, publisher }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  const repo = new CampaignRepository(pool);
  const webhookService = new ProviderWebhookService(pool, publisher ?? hub ?? noopPublisher);

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  const v1 = express.Router();
  v1.use(webhookRoutes(webhookService));
  v1.use(express.json({ limit: '16kb' }));
  v1.use(campaignRoutes(repo));
  if (hub) v1.use(liveRoutes(repo, hub));

  app.use(mountVersions({ v1 }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status >= 500 ? 'internal_error' : (err.type ?? 'bad_request') });
  };
  app.use(onError);

  return app;
}
