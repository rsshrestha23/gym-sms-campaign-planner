import type { CampaignSummary, CapacityReport, PlanRun, SendItem, SendsPage, SendStatus } from './types';

export const SNAPSHOT_PAGE_SIZE = 1000;
/** The dashboard pins itself to v1 explicitly rather than relying on the unversioned alias. */
export const API_BASE = '/v1';

export interface SendFilters {
  branchId?: number | null;
  status?: SendStatus | null;
}

export interface CampaignApi {
  getSummary(campaignId: number, signal?: AbortSignal): Promise<CampaignSummary>;
  getSendsPage(campaignId: number, cursor: string | null, signal?: AbortSignal, filters?: SendFilters): Promise<SendsPage>;
  plan(campaignId: number): Promise<CampaignSummary & { created: boolean }>;
  /** Starts (or joins) the plan run without waiting: 202 { planRunId, status }. */
  planAsync?(campaignId: number): Promise<{ planRunId: number; status: PlanRun['status'] }>;
  getPlanRun?(campaignId: number, planRunId: number): Promise<PlanRun>;
  getCapacity?(campaignId: number, signal?: AbortSignal): Promise<CapacityReport>;
  eventsUrl(campaignId: number): string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export function createApi(baseUrl = API_BASE): CampaignApi {
  return {
    getSummary: (id, signal) => fetch(`${baseUrl}/campaigns/${id}/summary`, { signal }).then(json<CampaignSummary>),
    getSendsPage: (id, cursor, signal, filters) => {
      const params = new URLSearchParams({ limit: String(SNAPSHOT_PAGE_SIZE) });
      if (cursor) params.set('cursor', cursor);
      if (filters?.branchId) params.set('branchId', String(filters.branchId));
      if (filters?.status) params.set('status', filters.status);
      return fetch(`${baseUrl}/campaigns/${id}/sends?${params}`, { signal }).then(json<SendsPage>);
    },
    plan: (id) => fetch(`${baseUrl}/campaigns/${id}/plan`, { method: 'POST' }).then(json<CampaignSummary & { created: boolean }>),
    planAsync: (id) =>
      fetch(`${baseUrl}/campaigns/${id}/plan`, { method: 'POST', headers: { prefer: 'respond-async' } }).then(
        json<{ planRunId: number; status: PlanRun['status'] }>,
      ),
    getPlanRun: (id, runId) => fetch(`${baseUrl}/campaigns/${id}/plan-runs/${runId}`).then(json<PlanRun>),
    getCapacity: (id, signal) => fetch(`${baseUrl}/campaigns/${id}/capacity`, { signal }).then(json<CapacityReport>),
    eventsUrl: (id) => `${baseUrl}/campaigns/${id}/events`,
  };
}

/** Reads sends through keyset pagination, up to `limit` rows (five 1,000-row pages for the demo). */
export async function fetchAllSends(
  api: CampaignApi,
  campaignId: number,
  signal?: AbortSignal,
  { filters, limit = Number.POSITIVE_INFINITY }: { filters?: SendFilters; limit?: number } = {},
): Promise<{ items: SendItem[]; truncated: boolean }> {
  const items: SendItem[] = [];
  let cursor: string | null = null;
  do {
    const page: SendsPage = await api.getSendsPage(campaignId, cursor, signal, filters);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < limit);
  return { items: items.slice(0, limit), truncated: Boolean(cursor) || items.length > limit };
}
