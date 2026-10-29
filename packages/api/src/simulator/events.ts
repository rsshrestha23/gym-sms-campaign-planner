import type { PlannedSendRef, ProviderEventPayload } from './provider-client';

export const DEFAULT_SEED = 20261029;
export type FinalOutcome = 'delivered' | 'undelivered' | 'failed';

/** mulberry32: tiny, fast, fixed-seed PRNG so every simulator run is reproducible. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Exactly floor(85%) delivered, floor(10%) undelivered, remainder failed, then shuffled. */
export function finalOutcomes(count: number, rng: () => number): FinalOutcome[] {
  const delivered = Math.floor(count * 0.85);
  const undelivered = Math.floor(count * 0.1);
  const failed = count - delivered - undelivered;
  return shuffle(
    [
      ...Array<FinalOutcome>(delivered).fill('delivered'),
      ...Array<FinalOutcome>(undelivered).fill('undelivered'),
      ...Array<FinalOutcome>(failed).fill('failed'),
    ],
    rng,
  );
}

export interface GeneratedBatch {
  /** One `sent` and one final event per planned send. */
  events: ProviderEventPayload[];
  /** Every HTTP request body to send: each event repeated 1–3 times, all copies shuffled together. */
  requests: ProviderEventPayload[];
  outcomes: Record<FinalOutcome, number>;
}

export function generateBatch(sends: PlannedSendRef[], seed = DEFAULT_SEED): GeneratedBatch {
  const rng = createRng(seed);
  const ordered = [...sends].sort((a, b) => a.id - b.id);
  const finals = finalOutcomes(ordered.length, rng);
  const outcomes: Record<FinalOutcome, number> = { delivered: 0, undelivered: 0, failed: 0 };
  const events: ProviderEventPayload[] = [];

  ordered.forEach((send, i) => {
    const scheduled = Date.parse(send.scheduledAt);
    const sentAt = scheduled + 1_000 + Math.floor(rng() * 30_000);
    const finalAt = sentAt + 2_000 + Math.floor(rng() * 120_000);
    const final = finals[i];
    outcomes[final]++;
    events.push(
      { eventId: `sim-${send.id}-sent`, sendId: send.id, status: 'sent', occurredAt: new Date(sentAt).toISOString() },
      { eventId: `sim-${send.id}-final`, sendId: send.id, status: final, occurredAt: new Date(finalAt).toISOString() },
    );
  });

  const requests: ProviderEventPayload[] = [];
  for (const event of events) {
    const copies = 1 + Math.floor(rng() * 3);
    for (let c = 0; c < copies; c++) requests.push(event);
  }
  shuffle(requests, rng);
  return { events, requests, outcomes };
}
