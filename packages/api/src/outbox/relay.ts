import type { SendJobData } from '../delivery/types';
import { LeasedDispatch, OutboxRepository } from './outbox-repository';

/** The slice of a BullMQ Queue the relay needs; lets tests inject failures. */
export interface JobQueue {
  add(name: string, data: SendJobData, opts: { jobId: string }): Promise<unknown>;
}

export interface RelayOptions {
  batchSize?: number;
  leaseMs?: number;
  maxBackoffMs?: number;
  /** Fault injection for tests. */
  hooks?: { afterEnqueue?: (row: LeasedDispatch) => void | Promise<void> };
  onError?: (err: unknown, row: LeasedDispatch) => void;
}

export const SEND_JOB_NAME = 'send-sms';

/**
 * Moves committed dispatch outbox rows into BullMQ. A row is marked published only after Redis
 * accepted the job. If the relay dies between those two steps, the lease lapses and the row is
 * enqueued again under the same deterministic job id: BullMQ ignores the duplicate id, and the
 * worker's PostgreSQL claim makes any duplicate that does slip through harmless.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly queue: JobQueue,
    private readonly options: RelayOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 200;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
  }

  /** Relays one batch; returns how many rows were published. */
  async runOnce(): Promise<{ leased: number; published: number; failed: number }> {
    const rows = await this.outbox.leaseDispatchBatch(this.batchSize, this.leaseMs);
    let published = 0;
    let failed = 0;
    await Promise.all(
      rows.map(async (row) => {
        try {
          await this.queue.add(SEND_JOB_NAME, row.payload, { jobId: row.jobId });
          await this.options.hooks?.afterEnqueue?.(row);
          if (await this.outbox.markPublished(row.id, row.leaseToken)) published++;
        } catch (err) {
          failed++;
          this.options.onError?.(err, row);
          const backoff = Math.min(this.maxBackoffMs, 500 * 2 ** row.publishAttempts) * (0.5 + Math.random() / 2);
          await this.outbox
            .markFailed(row.id, row.leaseToken, err instanceof Error ? err.message : String(err), Math.round(backoff))
            .catch(() => undefined);
        }
      }),
    );
    return { leased: rows.length, published, failed };
  }

  /** Drains until a batch comes back short. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const { leased, published } = await this.runOnce();
      total += published;
      if (leased < this.batchSize) return total;
    }
  }
}
