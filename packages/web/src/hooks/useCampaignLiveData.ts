import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CampaignApi, createApi, fetchAllSends } from '../api/client';
import type { CampaignSummary, CapacityReport, PlanRun, SendItem, SendStatusChanged, StatusCounts } from '../api/types';
import { LiveStore, RowFilters } from '../lib/liveStore';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

/**
 * 'full': the whole campaign fits in the browser (the 5,000-row demo); rows, filters, and counts
 * are all client-side and exact.
 * 'server': the campaign is larger than `snapshotLimit` (e.g. 5M members). Rows are the first
 * `snapshotLimit` sends matching the filters, fetched server-side; counts come from the summary
 * projection and are refreshed on a short interval.
 */
export type SnapshotMode = 'full' | 'server';

export interface EventSourceLike {
  readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
}

export interface LiveDataDeps {
  api: CampaignApi;
  createEventSource: (url: string) => EventSourceLike;
  /** Batches React updates; defaults to one flush per animation frame. */
  scheduleFlush: (fn: () => void) => void;
  reconnectDelayMs: number;
  snapshotLimit: number;
  /** In server mode, how often counts are re-read from the summary projection. */
  summaryRefreshMs: number;
  planPollMs: number;
}

const EVENT_SOURCE_CLOSED = 2;

const defaultDeps: LiveDataDeps = {
  api: createApi(),
  createEventSource: (url) => new EventSource(url),
  scheduleFlush: (fn) =>
    typeof requestAnimationFrame === 'function' ? void requestAnimationFrame(() => fn()) : void setTimeout(fn, 16),
  reconnectDelayMs: 2000,
  snapshotLimit: 20_000,
  summaryRefreshMs: 3000,
  planPollMs: 500,
};

export interface CampaignLiveData {
  summary: CampaignSummary | null;
  capacity: CapacityReport | null;
  mode: SnapshotMode;
  /** Rows matching the filters, in send-id order (in server mode, the first `snapshotLimit`). */
  rows: SendItem[];
  /** True when more sends match the filters than were loaded (server mode only). */
  truncated: boolean;
  /** Live per-branch status counts. */
  counts: Record<number, StatusCounts>;
  loadedRows: number;
  connection: ConnectionState;
  loading: boolean;
  error: string | null;
  /** Live updates applied per second, averaged over the last second. */
  updatesPerSecond: number;
  /** Progress of a plan started from the page; null when idle. */
  planRun: PlanRun | null;
  plan: () => Promise<void>;
  refresh: () => void;
}

function countsFromSummary(summary: CampaignSummary | null): Record<number, StatusCounts> {
  const out: Record<number, StatusCounts> = {};
  for (const b of summary?.branches ?? []) out[b.id] = { ...b.counts };
  return out;
}

/**
 * Live campaign data. Ordering guarantees:
 * 1. Open the SSE stream first and wait for its `ready` frame (sent after the server subscribes us).
 * 2. Only then fetch the summary and send pages; updates that arrive meanwhile are merged by
 *    statusVersion, so neither a slow page nor a fast event can lose or regress a row.
 * 3. Every (re)connect repeats the snapshot from the database, recovering anything missed while
 *    disconnected (Redis Pub/Sub fan-out is transient by design).
 * 4. Store mutations are flushed to React at most once per animation frame.
 */
export function useCampaignLiveData(
  campaignId: number,
  filters: RowFilters,
  overrides: Partial<LiveDataDeps> = {},
): CampaignLiveData {
  const depsRef = useRef<LiveDataDeps>({ ...defaultDeps, ...overrides });
  const storeRef = useRef(new LiveStore());
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const [version, setVersion] = useState(0);
  const [summary, setSummary] = useState<CampaignSummary | null>(null);
  const [capacity, setCapacity] = useState<CapacityReport | null>(null);
  const [mode, setMode] = useState<SnapshotMode>('full');
  const [truncated, setTruncated] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatesPerSecond, setUpdatesPerSecond] = useState(0);
  const [planRun, setPlanRun] = useState<PlanRun | null>(null);
  const reloadRef = useRef<() => void>(() => undefined);
  const modeRef = useRef<SnapshotMode>('full');

  useEffect(() => {
    const deps = depsRef.current;
    const store = storeRef.current;
    store.clear();
    let disposed = false;
    let flushQueued = false;
    let generation = 0;
    let plannedAt: string | null | undefined;
    let abort: AbortController | null = null;
    let source: EventSourceLike | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      if (flushQueued || disposed) return;
      flushQueued = true;
      deps.scheduleFlush(() => {
        flushQueued = false;
        if (!disposed) setVersion(store.version);
      });
    };

    const loadSnapshot = async () => {
      const gen = ++generation;
      abort?.abort();
      abort = new AbortController();
      setLoading(true);
      try {
        const nextSummary = await deps.api.getSummary(campaignId, abort.signal);
        const nextMode: SnapshotMode = nextSummary.totals.total > deps.snapshotLimit ? 'server' : 'full';
        const { items, truncated: more } =
          nextMode === 'full'
            ? await fetchAllSends(deps.api, campaignId, abort.signal)
            : await fetchAllSends(deps.api, campaignId, abort.signal, {
                filters: filtersRef.current,
                limit: deps.snapshotLimit,
              });
        if (disposed || gen !== generation) return; // superseded by a newer snapshot
        const replace = nextMode === 'server' || (plannedAt !== undefined && plannedAt !== nextSummary.campaign.plannedAt);
        plannedAt = nextSummary.campaign.plannedAt;
        store.loadSnapshot(items, { replace });
        modeRef.current = nextMode;
        setMode(nextMode);
        setTruncated(more);
        setSummary(nextSummary);
        setError(null);
        flush();
        deps.api.getCapacity?.(campaignId, abort.signal).then(
          (c) => !disposed && setCapacity(c),
          () => undefined,
        );
      } catch (err) {
        if (disposed || gen !== generation || (err as Error).name === 'AbortError') return;
        setError((err as Error).message);
      } finally {
        if (!disposed && gen === generation) setLoading(false);
      }
    };
    reloadRef.current = () => void loadSnapshot();

    const connect = () => {
      if (disposed) return;
      setConnection((c) => (c === 'live' ? 'reconnecting' : c));
      const es = deps.createEventSource(deps.api.eventsUrl(campaignId));
      source = es;
      es.addEventListener('ready', () => {
        if (disposed || source !== es) return;
        setConnection('live');
        void loadSnapshot();
      });
      es.addEventListener('send.updated', (event) => {
        if (disposed || source !== es) return;
        const update = JSON.parse(event.data) as SendStatusChanged;
        if (store.applyUpdate(update)) flush();
      });
      es.onerror = () => {
        if (disposed || source !== es) return;
        setConnection('reconnecting');
        // The browser retries on its own unless the stream was closed for good (e.g. a 502).
        if (es.readyState === EVENT_SOURCE_CLOSED) {
          es.close();
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connect, deps.reconnectDelayMs);
        }
      };
    };
    connect();

    let lastApplied = store.appliedEvents;
    const meter = setInterval(() => {
      setUpdatesPerSecond(store.appliedEvents - lastApplied);
      lastApplied = store.appliedEvents;
    }, 1000);

    // Server mode: counts come from the projection, so refresh them while updates flow.
    const summaryTimer = setInterval(() => {
      if (modeRef.current !== 'server' || disposed) return;
      deps.api.getSummary(campaignId).then((s) => !disposed && setSummary(s), () => undefined);
    }, deps.summaryRefreshMs);

    return () => {
      disposed = true;
      abort?.abort();
      source?.close();
      clearTimeout(reconnectTimer);
      clearInterval(meter);
      clearInterval(summaryTimer);
    };
  }, [campaignId]);

  // Server mode filters on the server, so a filter change means a new filtered snapshot.
  useEffect(() => {
    if (modeRef.current === 'server') reloadRef.current();
  }, [filters.branchId, filters.status]);

  const rows = useMemo(
    () => storeRef.current.filtered(filters),
    // `version` tracks store mutations; the store itself is a stable ref.
    [version, filters.branchId, filters.status],
  );
  const counts = useMemo(
    () => (mode === 'server' ? countsFromSummary(summary) : storeRef.current.countsSnapshot()),
    [version, mode, summary],
  );

  const plan = useCallback(async () => {
    const { api, planPollMs } = depsRef.current;
    try {
      if (!api.planAsync || !api.getPlanRun) {
        await api.plan(campaignId);
      } else {
        const started = await api.planAsync(campaignId);
        for (;;) {
          const run = await api.getPlanRun(campaignId, started.planRunId);
          setPlanRun(run);
          if (run.status === 'completed') break;
          if (run.status === 'failed') throw new Error(`Planning failed: ${run.error ?? 'unknown error'}`);
          await new Promise((r) => setTimeout(r, planPollMs));
        }
      }
      reloadRef.current();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPlanRun(null);
    }
  }, [campaignId]);

  const refresh = useCallback(() => reloadRef.current(), []);

  return {
    summary,
    capacity,
    mode,
    rows,
    truncated,
    counts,
    loadedRows: storeRef.current.size,
    connection,
    loading,
    error,
    updatesPerSecond,
    planRun,
    plan,
    refresh,
  };
}
