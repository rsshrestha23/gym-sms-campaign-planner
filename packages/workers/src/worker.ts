import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import type { ClaimService } from '../../api/src/delivery/claim-service';
import type { SendJobData } from '../../api/src/delivery/types';
import { queueDepth, queueOldestWaitingSeconds, redisEvictedKeys, redisMemory, stalledJobs, workerActive } from './observability/metrics';
import { createSendSmsProcessor, ProcessResult } from './processors/send-sms';
import type { SmsProvider } from './providers/provider';

export interface SmsWorkerOptions {
  connection: IORedis;
  queueName: string;
  claims: ClaimService;
  provider: SmsProvider;
  /** Jobs processed concurrently by this process. */
  concurrency: number;
  /** Provider-account rate limit, enforced queue-wide across every worker process. */
  limiter?: { max: number; duration: number };
  maxAttempts: number;
  /** BullMQ job lock; must exceed the longest provider call between lock renewals. */
  lockDuration?: number;
  /** How often BullMQ looks for jobs whose worker died (default 30s). */
  stalledInterval?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export function createSmsWorker(options: SmsWorkerOptions): Worker<SendJobData, ProcessResult> {
  let worker: Worker<SendJobData, ProcessResult>;
  const processor = createSendSmsProcessor({
    claims: options.claims,
    provider: options.provider,
    maxAttempts: options.maxAttempts,
    log: options.log,
    onRateLimited: async (ms) => {
      await worker.rateLimit(ms);
      return Worker.RateLimitError();
    },
  });
  worker = new Worker<SendJobData, ProcessResult>(options.queueName, (job) => processor(job), {
    connection: options.connection,
    concurrency: options.concurrency,
    limiter: options.limiter,
    lockDuration: options.lockDuration ?? 60_000,
    stalledInterval: options.stalledInterval ?? 30_000,
    // Stalled jobs (worker died mid-job) go back to wait once; the DB claim lease prevents a
    // second provider call while the original claim is still live.
    maxStalledCount: 2,
    autorun: false,
  });
  worker.on('active', () => workerActive.inc());
  worker.on('completed', () => workerActive.dec());
  worker.on('failed', () => workerActive.dec());
  worker.on('stalled', (jobId) => {
    stalledJobs.inc();
    options.log?.('job.stalled', { jobId });
  });
  worker.on('error', (err) => options.log?.('worker.error', { error: err.message }));
  return worker;
}

/** Samples queue depth/age and Redis memory/eviction into Prometheus gauges. */
export async function sampleQueueMetrics(queue: Queue, redis: IORedis): Promise<void> {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'prioritized', 'paused');
  for (const [state, n] of Object.entries(counts)) queueDepth.set({ queue: queue.name, state }, n);
  const [oldest] = await queue.getWaiting(0, 0);
  queueOldestWaitingSeconds.set({ queue: queue.name }, oldest ? (Date.now() - oldest.timestamp) / 1000 : 0);
  const info = await redis.info();
  const read = (key: string) => Number(info.match(new RegExp(`^${key}:(\\d+)`, 'm'))?.[1] ?? 0);
  redisMemory.set({ kind: 'used' }, read('used_memory'));
  redisMemory.set({ kind: 'max' }, read('maxmemory'));
  redisEvictedKeys.set(read('evicted_keys'));
}
