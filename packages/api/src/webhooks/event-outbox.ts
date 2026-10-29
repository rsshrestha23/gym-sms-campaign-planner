import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { SendStatusChanged } from '../live/events';
import { statusFanoutLag } from '../observability/metrics';

/** Where committed status changes go: the in-process SSE hub, or Redis Pub/Sub for all replicas. */
export interface StatusFanout {
  publish(update: SendStatusChanged): void | Promise<void>;
}

/**
 * Relays status_event_outbox rows (written in the same transaction as each status change) to the
 * fan-out. Leases + SKIP LOCKED let every API instance and the relay process drain concurrently;
 * a crash between publish and mark just republishes, and clients dedupe by statusVersion.
 * Draining is coalesced: concurrent `drain()` calls share one in-flight pass plus one follow-up.
 */
export class StatusEventRelay {
  private running: Promise<number> | null = null;
  private again = false;

  constructor(
    private readonly pool: Pool,
    private readonly fanout: StatusFanout,
    private readonly options: { batchSize?: number; leaseMs?: number } = {},
  ) {}

  drain(): Promise<number> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let total = 0;
      try {
        do {
          this.again = false;
          for (;;) {
            const n = await this.runOnce();
            total += n;
            if (n < (this.options.batchSize ?? 500)) break;
          }
        } while (this.again);
      } finally {
        this.running = null;
      }
      return total;
    })();
    return this.running;
  }

  async runOnce(): Promise<number> {
    const token = randomUUID();
    const { rows } = await this.pool.query<{ id: number; payload: SendStatusChanged; created_at: Date }>(
      `UPDATE status_event_outbox o SET lease_token = $1, lease_expires_at = now() + ($2 || ' milliseconds')::interval
        WHERE o.id IN (
          SELECT id FROM status_event_outbox
           WHERE published_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at < now())
           ORDER BY id LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING o.id, o.payload, o.created_at`,
      [token, String(this.options.leaseMs ?? 10_000), this.options.batchSize ?? 500],
    );
    if (rows.length === 0) return 0;
    rows.sort((a, b) => Number(a.id) - Number(b.id));
    const published: number[] = [];
    for (const row of rows) {
      try {
        await this.fanout.publish(row.payload);
        published.push(Number(row.id));
        statusFanoutLag.observe((Date.now() - row.created_at.getTime()) / 1000);
      } catch {
        break; // fan-out down: leave the rest leased; they become available again when it lapses
      }
    }
    if (published.length) {
      await this.pool.query(
        `UPDATE status_event_outbox SET published_at = now(), lease_token = NULL, lease_expires_at = NULL
          WHERE id = ANY($1) AND lease_token = $2`,
        [published, token],
      );
    }
    return published.length;
  }
}
