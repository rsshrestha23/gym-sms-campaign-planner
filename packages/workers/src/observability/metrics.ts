import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from '../../../api/src/observability/metrics';

export { registry };

export const providerLatency = new Histogram({
  name: 'gym_provider_request_seconds',
  help: 'SMS provider call latency by outcome.',
  labelNames: ['outcome'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const providerResponses = new Counter({
  name: 'gym_provider_responses_total',
  help: 'Provider call outcomes: accepted, retryable_error, rate_limited, permanent_error, ambiguous.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const jobResults = new Counter({
  name: 'gym_send_jobs_total',
  help: 'Send job results: sent, failed, retry, dead_letter, suppressed, skipped.',
  labelNames: ['result', 'reason'] as const,
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'gym_queue_jobs',
  help: 'BullMQ jobs by state.',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
});

export const queueOldestWaitingSeconds = new Gauge({
  name: 'gym_queue_oldest_waiting_seconds',
  help: 'Age of the oldest waiting job.',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const workerActive = new Gauge({
  name: 'gym_worker_active_jobs',
  help: 'Jobs currently being processed by this worker process.',
  registers: [registry],
});

export const stalledJobs = new Counter({
  name: 'gym_worker_stalled_jobs_total',
  help: 'Jobs BullMQ detected as stalled and returned to the queue.',
  registers: [registry],
});

export const redisMemory = new Gauge({
  name: 'gym_redis_memory_bytes',
  help: 'Redis used_memory and maxmemory (labels: kind).',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const redisEvictedKeys = new Gauge({
  name: 'gym_redis_evicted_keys',
  help: 'Redis evicted_keys counter; must stay 0 for BullMQ (noeviction).',
  registers: [registry],
});
