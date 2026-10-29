import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CampaignApi, createApi, fetchAllSends } from '../api/client';
import type { CampaignSummary, SendItem, SendStatusChanged, StatusCounts } from '../api/types';
import { LiveStore, RowFilters } from '../lib/liveStore';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

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
}

const EVENT_SOURCE_CLOSED = 2;

const defaultDeps: LiveDataDeps = {
  api: createApi(),
  createEventSource: (url) => new EventSource(url),
  scheduleFlush: (fn) =>
    typeof requestAnimationFrame === 'function' ? void requestAnimationFrame(() => fn()) : void setTimeout(fn, 16),
  reconnectDelayMs: 2000,
};

export interface CampaignLiveData {
  summary: CampaignSummary | null;
  /** Rows matching the filters, in send-id order. */
  rows: SendItem[];
  /** Live per-branch status counts over all loaded rows (ignores filters). */
  counts: Record<number, StatusCounts>;
  loadedRows: number;
  connection: ConnectionState;
  loading: boolean;
  error: string | null;
  /** Live updates applied per second, averaged over the last second. */
  updatesPerSecond: number;
  plan: () => Promise<void>;
  refresh: () => void;
}

/**
 * Live campaign data. Ordering guarantees:
 * 1. Open the SSE stream first and wait for its `ready` frame (sent after the server subscribes us).
 * 2. Only then fetch the summary and all send pages; updates that arrive meanwhile are merged by
 *    statusVersion, so neither a slow page nor a fast event can lose or regress a row.
 * 3. Every (re)connect repeats the snapshot, recovering anything missed while disconnected.
 * 4. Store mutations are flushed to React at most once per animation frame.
 */
export function useCampaignLiveData(
  campaignId: number,
  filters: RowFilters,
  overrides: Partial<LiveDataDeps> = {},
): CampaignLiveData {
  const depsRef = useRef<LiveDataDeps>({ ...defaultDeps, ...overrides });
  const storeRef = useRef(new LiveStore());
  const [version, setVersion] = useState(0);
  const [summary, setSummary] = useState<CampaignSummary | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatesPerSecond, setUpdatesPerSecond] = useState(0);
  const reloadRef = useRef<() => void>(() => undefined);

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
        const items = await fetchAllSends(deps.api, campaignId, abort.signal);
        if (disposed || gen !== generation) return; // superseded by a newer snapshot
        const replace = plannedAt !== undefined && plannedAt !== nextSummary.campaign.plannedAt;
        plannedAt = nextSummary.campaign.plannedAt;
        store.loadSnapshot(items, { replace });
        setSummary(nextSummary);
        setError(null);
        flush();
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

    return () => {
      disposed = true;
      abort?.abort();
      source?.close();
      clearTimeout(reconnectTimer);
      clearInterval(meter);
    };
  }, [campaignId]);

  const rows = useMemo(
    () => storeRef.current.filtered(filters),
    // `version` tracks store mutations; the store itself is a stable ref.
    [version, filters.branchId, filters.status],
  );
  const counts = useMemo(() => storeRef.current.countsSnapshot(), [version]);

  const plan = useCallback(async () => {
    try {
      await depsRef.current.api.plan(campaignId);
      reloadRef.current();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [campaignId]);

  const refresh = useCallback(() => reloadRef.current(), []);

  return {
    summary,
    rows,
    counts,
    loadedRows: storeRef.current.size,
    connection,
    loading,
    error,
    updatesPerSecond,
    plan,
    refresh,
  };
}
