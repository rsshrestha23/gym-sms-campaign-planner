/** The simulator is a client like any other, so it pins the API version it was written against. */
export const API_VERSION_PREFIX = '/v1';

export interface PlannedSendRef {
  id: number;
  scheduledAt: string;
}

export interface ProviderEventPayload {
  eventId: string;
  sendId: number;
  status: 'sent' | 'delivered' | 'undelivered' | 'failed';
  occurredAt: string;
}

export type DispatchOutcome = 'applied' | 'duplicate' | 'ignored' | 'rejected' | 'error';

export interface DispatchReport {
  attempted: number;
  applied: number;
  duplicate: number;
  ignored: number;
  rejected: number;
  error: number;
  maxInFlight: number;
  elapsedMs: number;
}

type FetchFn = typeof fetch;

/** Reads every `planned` send of a campaign through the public API, following cursors. */
export async function fetchPlannedSends(
  baseUrl: string,
  campaignId: number,
  { pageSize = 1000, fetchFn = fetch }: { pageSize?: number; fetchFn?: FetchFn } = {},
): Promise<PlannedSendRef[]> {
  const sends: PlannedSendRef[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(`${API_VERSION_PREFIX}/campaigns/${campaignId}/sends`, baseUrl);
    url.searchParams.set('status', 'planned');
    url.searchParams.set('limit', String(pageSize));
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as { items: { id: number; scheduledAt: string }[]; nextCursor: string | null };
    for (const item of page.items) sends.push({ id: item.id, scheduledAt: item.scheduledAt });
    cursor = page.nextCursor;
  } while (cursor);
  return sends;
}

/**
 * POSTs every payload to /v1/webhooks/provider with at most `concurrency` requests in flight.
 * `ratePerSecond` additionally spaces request starts for a slower demo.
 */
export async function dispatchEvents(
  baseUrl: string,
  payloads: ProviderEventPayload[],
  {
    concurrency = 50,
    ratePerSecond,
    fetchFn = fetch,
    onProgress,
  }: {
    concurrency?: number;
    ratePerSecond?: number;
    fetchFn?: FetchFn;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<DispatchReport> {
  const url = new URL(`${API_VERSION_PREFIX}/webhooks/provider`, baseUrl);
  const report: DispatchReport = {
    attempted: 0,
    applied: 0,
    duplicate: 0,
    ignored: 0,
    rejected: 0,
    error: 0,
    maxInFlight: 0,
    elapsedMs: 0,
  };
  const startedAt = Date.now();
  const intervalMs = ratePerSecond && ratePerSecond > 0 ? 1000 / ratePerSecond : 0;
  let nextIndex = 0;
  let inFlight = 0;
  let done = 0;

  const waitForStartSlot = async (index: number) => {
    if (!intervalMs) return;
    const due = startedAt + index * intervalMs;
    const delay = due - Date.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  };

  const worker = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= payloads.length) return;
      await waitForStartSlot(index);
      inFlight++;
      report.maxInFlight = Math.max(report.maxInFlight, inFlight);
      report.attempted++;
      let outcome: DispatchOutcome;
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payloads[index]),
        });
        const body = (await res.json().catch(() => ({}))) as { result?: string };
        if (res.status === 200 && (body.result === 'applied' || body.result === 'duplicate' || body.result === 'ignored')) {
          outcome = body.result;
        } else if (res.status >= 400 && res.status < 500) {
          outcome = 'rejected';
        } else {
          outcome = 'error';
        }
      } catch {
        outcome = 'error';
      } finally {
        inFlight--;
      }
      report[outcome]++;
      onProgress?.(++done, payloads.length);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, payloads.length)) }, worker));
  report.elapsedMs = Date.now() - startedAt;
  return report;
}
