import type IORedis from 'ioredis';
import type { StatusFanout } from '../webhooks/event-outbox';
import type { SendStatusChanged, SendUpdatePublisher } from './events';

/** Namespaced, versioned channel per campaign. */
export const statusChannel = (campaignId: number) => `gym:v1:campaign:${campaignId}:send-status`;
const PATTERN = 'gym:v1:campaign:*:send-status';

/**
 * Publishes committed status changes to Redis Pub/Sub so every API replica's SSE clients see them.
 * Pub/Sub is transient fan-out, not history: anything missed is repaired by the client's snapshot
 * reconciliation on reconnect (Redis Streams would only be needed for durable replay).
 */
export class RedisStatusFanout implements StatusFanout {
  constructor(private readonly redis: IORedis) {}

  async publish(update: SendStatusChanged): Promise<void> {
    await this.redis.publish(statusChannel(update.campaignId), JSON.stringify(update));
  }
}

/** Subscribes this API instance (on a dedicated connection) and forwards to its local SSE hub. */
export class RedisStatusSubscriber {
  constructor(
    private readonly subscriber: IORedis,
    private readonly local: SendUpdatePublisher,
  ) {}

  async start(): Promise<void> {
    this.subscriber.on('pmessage', (_pattern, _channel, message) => {
      try {
        this.local.publish(JSON.parse(message) as SendStatusChanged);
      } catch {
        // A malformed message must not take the subscriber down.
      }
    });
    await this.subscriber.psubscribe(PATTERN);
  }

  async stop(): Promise<void> {
    await this.subscriber.punsubscribe(PATTERN).catch(() => undefined);
    this.subscriber.disconnect();
  }
}
