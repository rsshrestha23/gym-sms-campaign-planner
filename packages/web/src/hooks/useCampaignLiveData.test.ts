import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CampaignApi } from '../api/client';
import type { CampaignSummary, SendItem, SendStatus, SendsPage } from '../api/types';
import { zeroCounts } from '../api/types';
import { EventSourceLike, LiveDataDeps, useCampaignLiveData } from './useCampaignLiveData';

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(public url: string, log: string[]) {
    FakeEventSource.instances.push(this);
    log.push('eventsource');
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    this.readyState = 1;
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent);
  }
  fail(closed = false) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event('error'));
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const send = (id: number, branchId: number, status: SendStatus = 'planned', statusVersion = 1): SendItem => ({
  id, campaignId: 1, memberId: id, branchId, memberName: `M${id}`, phone: `+${id}`, status,
  scheduledAt: '2026-10-23T08:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z', statusVersion,
});
const update = (sendId: number, branchId: number, status: SendStatus, statusVersion: number) => ({
  campaignId: 1, sendId, branchId, status, statusVersion, scheduledAt: '2026-10-23T08:00:00.000Z', updatedAt: '2026-10-29T01:00:00.000Z',
});
const summary: CampaignSummary = {
  campaign: { id: 1, name: 'Win-back October', startDate: '2026-10-23', endDate: '2026-10-29', plannedAt: '2026-10-29T00:00:00.000Z' },
  totals: { ...zeroCounts(), total: 0 },
  branches: [1, 2].map((id) => ({
    id, name: `B${id}`, timeZone: 'UTC', total: 0, counts: zeroCounts(), earliestScheduledAt: null, latestScheduledAt: null,
  })),
};

/** A fake API whose page responses the test releases manually. */
function setup(pagesData: SendItem[][]) {
  const log: string[] = [];
  const pageRequests: { cursor: string | null; release: (p?: SendsPage) => void }[] = [];
  let snapshotData = pagesData;
  const api: CampaignApi = {
    eventsUrl: (id) => `/campaigns/${id}/events`,
    getSummary: async () => {
      log.push('summary');
      return summary;
    },
    getSendsPage: (_id, cursor) => {
      log.push(`page:${cursor ?? 'start'}`);
      const d = deferred<SendsPage>();
      const index = cursor ? Number(cursor) : 0;
      pageRequests.push({
        cursor,
        release: (p) =>
          d.resolve(p ?? { items: snapshotData[index], nextCursor: index + 1 < snapshotData.length ? String(index + 1) : null }),
      });
      return d.promise;
    },
    plan: async () => ({ ...summary, created: true }),
  };
  FakeEventSource.instances = [];
  const flushes: (() => void)[] = [];
  const deps: Partial<LiveDataDeps> = {
    api,
    createEventSource: (url) => new FakeEventSource(url, log),
    scheduleFlush: (fn) => void flushes.push(fn),
    reconnectDelayMs: 5,
  };
  const flush = () => act(() => flushes.splice(0).forEach((fn) => fn()));
  const releaseNext = async () => {
    await waitFor(() => expect(pageRequests.length).toBeGreaterThan(0));
    await act(async () => pageRequests.shift()!.release());
  };
  return {
    log, deps, flushes, flush, releaseNext, pageRequests,
    setSnapshot: (d: SendItem[][]) => (snapshotData = d),
    es: () => FakeEventSource.instances[FakeEventSource.instances.length - 1],
  };
}

const ALL = { branchId: null, status: null } as const;

describe('useCampaignLiveData', () => {
  it('opens SSE before fetching and fetches only after the stream is ready', async () => {
    const t = setup([[send(1, 1)]]);
    renderHook(() => useCampaignLiveData(1, ALL, t.deps));
    expect(t.log).toEqual(['eventsource']);
    expect(t.es().url).toBe('/campaigns/1/events');
    act(() => t.es().emit('ready', { campaignId: 1 }));
    await waitFor(() => expect(t.log).toEqual(['eventsource', 'summary', 'page:start']));
  });

  it('loads every page and merges updates that arrived mid-snapshot by statusVersion', async () => {
    const t = setup([[send(1, 1), send(2, 1)], [send(3, 2), send(4, 2)]]);
    const { result } = renderHook(() => useCampaignLiveData(1, ALL, t.deps));
    act(() => t.es().emit('ready', {}));
    await t.releaseNext();
    // Arrives while page 2 is in flight: one for a loaded row, one for a row still to come.
    act(() => {
      t.es().emit('send.updated', update(1, 1, 'sent', 2));
      t.es().emit('send.updated', update(4, 2, 'delivered', 3));
    });
    await t.releaseNext();
    t.flush();
    await waitFor(() => expect(result.current.loadedRows).toBe(4));
    expect(result.current.rows.map((r) => [r.id, r.status])).toEqual([
      [1, 'sent'], [2, 'planned'], [3, 'planned'], [4, 'delivered'],
    ]);
    expect(result.current.counts[1]).toMatchObject({ planned: 1, sent: 1 });
    expect(result.current.counts[2]).toMatchObject({ planned: 1, delivered: 1 });
  });

  it('ignores an older page response that races a newer live update', async () => {
    const t = setup([[send(1, 1)]]);
    const { result } = renderHook(() => useCampaignLiveData(1, ALL, t.deps));
    act(() => t.es().emit('ready', {}));
    await waitFor(() => expect(t.pageRequests.length).toBe(1));
    act(() => t.es().emit('send.updated', update(1, 1, 'failed', 2)));
    await t.releaseNext(); // page still says planned v1
    t.flush();
    await waitFor(() => expect(result.current.rows[0]).toMatchObject({ status: 'failed', statusVersion: 2 }));
    expect(result.current.counts[1]).toMatchObject({ planned: 0, failed: 1 });
  });

  it('coalesces many updates, including several for one send, into one flush', async () => {
    const t = setup([[send(1, 1), send(2, 1), send(3, 2)]]);
    const { result } = renderHook(() => useCampaignLiveData(1, ALL, t.deps));
    act(() => t.es().emit('ready', {}));
    await t.releaseNext();
    t.flush();
    await waitFor(() => expect(result.current.loadedRows).toBe(3));

    act(() => {
      t.es().emit('send.updated', update(1, 1, 'sent', 2));
      t.es().emit('send.updated', update(1, 1, 'delivered', 3));
      t.es().emit('send.updated', update(1, 1, 'sent', 2)); // stale replay
      t.es().emit('send.updated', update(2, 1, 'undelivered', 2));
      t.es().emit('send.updated', update(3, 2, 'sent', 2));
    });
    expect(t.flushes).toHaveLength(1);
    expect(result.current.counts[1]).toMatchObject({ planned: 2 }); // not rendered until the frame
    t.flush();
    expect(result.current.counts[1]).toMatchObject({ planned: 0, sent: 0, delivered: 1, undelivered: 1 });
    expect(result.current.counts[2]).toMatchObject({ planned: 0, sent: 1 });
  });

  it('applies filters locally and keeps rows current as they change', async () => {
    const t = setup([[send(1, 1), send(2, 2), send(3, 2)]]);
    const { result, rerender } = renderHook(({ f }) => useCampaignLiveData(1, f, t.deps), {
      initialProps: { f: { branchId: 2, status: 'planned' as SendStatus | null } },
    });
    act(() => t.es().emit('ready', {}));
    await t.releaseNext();
    t.flush();
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual([2, 3]));
    act(() => t.es().emit('send.updated', update(3, 2, 'sent', 2)));
    t.flush();
    expect(result.current.rows.map((r) => r.id)).toEqual([2]);
    rerender({ f: { branchId: 2, status: null } });
    expect(result.current.rows.map((r) => [r.id, r.status])).toEqual([[2, 'planned'], [3, 'sent']]);
  });

  it('reconciles with a fresh snapshot after reconnecting', async () => {
    const t = setup([[send(1, 1), send(2, 1)]]);
    const { result } = renderHook(() => useCampaignLiveData(1, ALL, t.deps));
    const first = t.es();
    act(() => first.emit('ready', {}));
    await t.releaseNext();
    t.flush();
    await waitFor(() => expect(result.current.connection).toBe('live'));

    act(() => first.fail(true)); // closed for good, e.g. a 502 from the proxy
    expect(result.current.connection).toBe('reconnecting');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(first.closed).toBe(true);

    // Send 2 was delivered while we were disconnected; the event itself was missed.
    t.setSnapshot([[send(1, 1), send(2, 1, 'delivered', 3)]]);
    act(() => t.es().emit('ready', {}));
    await t.releaseNext();
    t.flush();
    await waitFor(() => expect(result.current.rows[1]).toMatchObject({ status: 'delivered' }));
    expect(result.current.connection).toBe('live');
    expect(result.current.counts[1]).toMatchObject({ planned: 1, delivered: 1 });
  });

  it('drops a superseded snapshot that finishes after a newer one', async () => {
    const t = setup([[send(1, 1)]]);
    const { result } = renderHook(() => useCampaignLiveData(1, ALL, t.deps));
    act(() => t.es().emit('ready', {}));
    await waitFor(() => expect(t.pageRequests.length).toBe(1));
    const stale = t.pageRequests.shift()!;
    act(() => t.es().emit('ready', {})); // reconnect before the first snapshot finished
    await waitFor(() => expect(t.pageRequests.length).toBe(1));
    await act(async () => t.pageRequests.shift()!.release({ items: [send(1, 1, 'sent', 2)], nextCursor: null }));
    await act(async () => stale.release({ items: [send(1, 1, 'planned', 1)], nextCursor: null }));
    t.flush();
    await waitFor(() => expect(result.current.rows[0]).toMatchObject({ status: 'sent', statusVersion: 2 }));
  });

  it('closes the stream on unmount', async () => {
    const t = setup([[send(1, 1)]]);
    const { unmount } = renderHook(() => useCampaignLiveData(1, ALL, t.deps));
    unmount();
    expect(t.es().closed).toBe(true);
  });
});
