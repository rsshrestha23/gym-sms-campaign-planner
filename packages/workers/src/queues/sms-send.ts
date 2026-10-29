import { DefaultJobOptions, Queue, QueueOptions } from 'bullmq';
import IORedis from 'ioredis';
import { SendJobData, smsQueueName } from '../../../api/src/delivery/types';

export { smsQueueName };

export const DEFAULT_MAX_ATTEMPTS = 8;

export const defaultJobOptions: DefaultJobOptions = {
  attempts: DEFAULT_MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: 2_000, jitter: 0.5 },
  // Keep a bounded window for inspection; PostgreSQL holds the durable history.
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** BullMQ needs maxRetriesPerRequest: null for blocking worker connections. */
export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export function createSmsQueue(
  connection: IORedis,
  providerAccount: string,
  options: Partial<QueueOptions> = {},
): Queue<SendJobData> {
  return new Queue<SendJobData>(smsQueueName(providerAccount), {
    connection,
    defaultJobOptions,
    ...options,
  });
}
