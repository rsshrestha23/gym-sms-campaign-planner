import type { Response } from 'express';
import { sseClients } from '../observability/metrics';
import type { SendStatusChanged, SendUpdatePublisher } from './events';

/**
 * Single-process fan-out of committed send updates to SSE clients, scoped per campaign.
 * Replicated API instances would need shared pub/sub (e.g. Postgres LISTEN/NOTIFY or Redis) instead.
 */
export class SseHub implements SendUpdatePublisher {
  private readonly clients = new Map<number, Set<Response>>();
  private readonly heartbeat: NodeJS.Timeout;

  /**
   * @param maxBufferedBytes a client that can't keep up (its socket buffer grows past this) is
   *   disconnected rather than buffered without bound; it reconnects and reconciles from a snapshot.
   */
  constructor(heartbeatMs = 15_000, private readonly maxBufferedBytes = 1 << 20) {
    this.heartbeat = setInterval(() => this.broadcastRaw(': heartbeat\n\n'), heartbeatMs);
    this.heartbeat.unref();
  }

  subscribe(campaignId: number, res: Response): () => void {
    let set = this.clients.get(campaignId);
    if (!set) this.clients.set(campaignId, (set = new Set()));
    set.add(res);
    sseClients.inc();
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      set!.delete(res);
      sseClients.dec();
      if (set!.size === 0) this.clients.delete(campaignId);
    };
  }

  clientCount(campaignId?: number): number {
    if (campaignId !== undefined) return this.clients.get(campaignId)?.size ?? 0;
    let n = 0;
    for (const set of this.clients.values()) n += set.size;
    return n;
  }

  publish(update: SendStatusChanged): void {
    const set = this.clients.get(update.campaignId);
    if (!set) return;
    const frame = `event: send.updated\ndata: ${JSON.stringify(update)}\n\n`;
    for (const res of set) this.write(res, frame);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const set of this.clients.values()) for (const res of set) res.end();
    this.clients.clear();
  }

  private broadcastRaw(frame: string): void {
    for (const set of this.clients.values()) for (const res of set) this.write(res, frame);
  }

  private write(res: Response, frame: string): void {
    if (res.writableLength > this.maxBufferedBytes) {
      res.end(); // slow consumer: drop it; 'close' unsubscribes it
      return;
    }
    res.write(frame);
  }
}
