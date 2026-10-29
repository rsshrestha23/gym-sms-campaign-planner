import type { CampaignSummary, SendItem, SendsPage } from './types';

export const SNAPSHOT_PAGE_SIZE = 1000;

export interface CampaignApi {
  getSummary(campaignId: number, signal?: AbortSignal): Promise<CampaignSummary>;
  getSendsPage(campaignId: number, cursor: string | null, signal?: AbortSignal): Promise<SendsPage>;
  plan(campaignId: number): Promise<CampaignSummary & { created: boolean }>;
  eventsUrl(campaignId: number): string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export function createApi(baseUrl = ''): CampaignApi {
  return {
    getSummary: (id, signal) => fetch(`${baseUrl}/campaigns/${id}/summary`, { signal }).then(json<CampaignSummary>),
    getSendsPage: (id, cursor, signal) => {
      const params = new URLSearchParams({ limit: String(SNAPSHOT_PAGE_SIZE) });
      if (cursor) params.set('cursor', cursor);
      return fetch(`${baseUrl}/campaigns/${id}/sends?${params}`, { signal }).then(json<SendsPage>);
    },
    plan: (id) => fetch(`${baseUrl}/campaigns/${id}/plan`, { method: 'POST' }).then(json<CampaignSummary & { created: boolean }>),
    eventsUrl: (id) => `${baseUrl}/campaigns/${id}/events`,
  };
}

/** Reads every send through keyset pagination (five 1,000-row pages for the seeded campaign). */
export async function fetchAllSends(api: CampaignApi, campaignId: number, signal?: AbortSignal): Promise<SendItem[]> {
  const items: SendItem[] = [];
  let cursor: string | null = null;
  do {
    const page: SendsPage = await api.getSendsPage(campaignId, cursor, signal);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
