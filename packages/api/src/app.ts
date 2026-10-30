import { randomUUID } from 'node:crypto';
import express, { ErrorRequestHandler, Express } from 'express';
import { Pool } from 'pg';
import { adminRoutes, QueueControl } from './admin/routes';
import { CampaignRepository } from './campaigns/repository';
import { campaignRoutes } from './campaigns/routes';
import { healthRoutes, ReadinessCheck } from './health/readiness';
import { noopPublisher, SendUpdatePublisher } from './live/events';
import { liveRoutes } from './live/routes';
import { SseHub } from './live/sse-hub';
import { logger, requestContext } from './observability/logger';
import { registry } from './observability/metrics';
import { StatusEventRelay, StatusFanout } from './webhooks/event-outbox';
import { ProviderWebhookService } from './webhooks/provider-service';
import { webhookRoutes, WebhookOptions } from './webhooks/routes';
import { twilioWebhookRoutes, TwilioWebhookOptions } from './webhooks/twilio';
import { mountVersions } from './versioning';

export interface AppDeps {
  pool: Pool;
  /** SSE hub for GET /v1/campaigns/:id/events. */
  hub?: SseHub;
  /**
   * Where committed status changes are fanned out. Defaults to `publisher`, then the local hub
   * (single instance). With several replicas this is Redis Pub/Sub and each replica's hub is fed
   * by its Redis subscriber instead.
   */
  fanout?: StatusFanout;
  /** Kept for tests and single-process setups: receives each fanned-out change. */
  publisher?: SendUpdatePublisher;
  /**
   * After a webhook commits, drain the status outbox before responding ('await', deterministic for
   * a single instance) or in the background ('background', so a slow fan-out never delays the
   * provider). Rows left behind are picked up by the periodic/relay drain either way.
   */
  statusDrain?: 'await' | 'background';
  webhook?: WebhookOptions;
  /** Enables POST /v1/webhooks/twilio (Twilio status callbacks). */
  twilio?: TwilioWebhookOptions;
  readinessChecks?: ReadinessCheck[];
  /** Enables /v1/admin when set. */
  adminToken?: string;
  queueControl?: QueueControl;
  /** Exposes /metrics (Prometheus). Internal only: the public proxy does not route it. */
  metrics?: boolean;
}

export interface App extends Express {
  statusRelay: StatusEventRelay;
}

export function createApp({
  pool,
  hub,
  fanout,
  publisher,
  statusDrain = 'await',
  webhook,
  twilio,
  readinessChecks,
  adminToken,
  queueControl,
  metrics = true,
}: AppDeps): App {
  const app = express() as App;
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  const statusRelay = new StatusEventRelay(pool, fanout ?? publisher ?? hub ?? noopPublisher);
  app.statusRelay = statusRelay;
  const repo = new CampaignRepository(pool);
  const webhookService = new ProviderWebhookService(pool, () =>
    statusDrain === 'await' ? statusRelay.drain().then(() => undefined) : void statusRelay.drain().catch(() => undefined),
  );

  // Correlation id for logs and traces; echoed back so callers can quote it.
  app.use((req, res, next) => {
    const correlationId = req.get('x-request-id') ?? randomUUID();
    res.setHeader('X-Request-Id', correlationId);
    requestContext.run({ correlationId }, next);
  });

  app.use(healthRoutes(pool, readinessChecks));
  if (metrics) {
    app.get('/metrics', async (_req, res) => {
      res.setHeader('content-type', registry.contentType);
      res.end(await registry.metrics());
    });
  }

  const v1 = express.Router();
  v1.use(webhookRoutes(webhookService, webhook));
  if (twilio) v1.use(twilioWebhookRoutes(webhookService, twilio));
  v1.use(express.json({ limit: '16kb' }));
  v1.use(campaignRoutes(repo));
  if (hub) v1.use(liveRoutes(repo, hub));
  if (adminToken) v1.use(adminRoutes(pool, adminToken, queueControl));

  app.use(mountVersions({ v1 }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status >= 500) logger.error('request.failed', { error: err instanceof Error ? err.message : String(err) });
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status >= 500 ? 'internal_error' : (err.type ?? 'bad_request') });
  };
  app.use(onError);

  return app;
}
