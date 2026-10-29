import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics (scrapeable by Prometheus or an OpenTelemetry collector's prometheus
 * receiver). One registry per process; each deployable registers what it emits.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const webhookRequests = new Counter({
  name: 'gym_webhook_requests_total',
  help: 'Provider webhook requests by result (applied, duplicate, ignored, invalid_signature, malformed, rate_limited, error).',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const sendTransitions = new Counter({
  name: 'gym_send_transitions_total',
  help: 'Committed send status transitions by new status and source.',
  labelNames: ['status', 'source'] as const,
  registers: [registry],
});

export const sseClients = new Gauge({
  name: 'gym_sse_clients',
  help: 'Connected dashboard SSE clients on this instance.',
  registers: [registry],
});

export const statusFanoutLag = new Histogram({
  name: 'gym_status_fanout_lag_seconds',
  help: 'Time from status change commit to fan-out publish.',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const dueSendLag = new Gauge({
  name: 'gym_due_send_lag_seconds',
  help: 'Age of the oldest due send still waiting for dispatch (0 when none).',
  registers: [registry],
});

export const dispatchedSends = new Counter({
  name: 'gym_dispatched_sends_total',
  help: 'Sends moved to queued by the due-send dispatcher, and sends marked missed.',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const outboxAge = new Gauge({
  name: 'gym_outbox_oldest_pending_seconds',
  help: 'Age of the oldest unpublished outbox row.',
  labelNames: ['outbox'] as const,
  registers: [registry],
});

export const reconciledDispatches = new Counter({
  name: 'gym_reconciled_dispatches_total',
  help: 'In-flight dispatches repaired because their BullMQ job was missing.',
  registers: [registry],
});
