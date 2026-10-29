import { Pool } from 'pg';
import { SEND_STATUSES, SendStatus } from '../sends/status-transition';
import { PlanRunCampaignNotFound } from './plan-run-repository';
import { ProductionPlanner } from './production-planner';

export type StatusCounts = Record<SendStatus, number>;

export interface BranchSummary {
  id: number;
  name: string;
  timeZone: string;
  total: number;
  counts: StatusCounts;
  earliestScheduledAt: string | null;
  latestScheduledAt: string | null;
}

export interface CampaignSummary {
  campaign: { id: number; name: string; startDate: string; endDate: string; plannedAt: string | null };
  totals: StatusCounts & { total: number };
  branches: BranchSummary[];
}

export interface SendRow {
  id: number;
  campaignId: number;
  memberId: number;
  branchId: number;
  memberName: string;
  phone: string;
  status: SendStatus;
  scheduledAt: string | null;
  updatedAt: string;
  statusVersion: number;
}

export interface ListSendsQuery {
  branchId?: number;
  status?: SendStatus;
  cursor?: number;
  limit: number;
}

export interface PlanResult {
  created: boolean;
  summary: CampaignSummary;
}

export class CampaignNotFoundError extends Error {
  constructor(id: number) {
    super(`Campaign ${id} not found`);
  }
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function zeroCounts(): StatusCounts {
  return Object.fromEntries(SEND_STATUSES.map((s) => [s, 0])) as StatusCounts;
}

export class CampaignRepository {
  readonly planner: ProductionPlanner;

  constructor(readonly pool: Pool, planner?: ProductionPlanner) {
    this.planner = planner ?? new ProductionPlanner(pool);
  }

  /**
   * Plans the campaign at most once and waits for the plan to finish. Delegates to the resumable
   * production planner: concurrent callers share one plan run, and a repeat returns the persisted,
   * immutable plan.
   */
  async plan(campaignId: number): Promise<PlanResult> {
    try {
      const { created } = await this.planner.planAndWait(campaignId);
      return { created, summary: (await this.summary(campaignId))! };
    } catch (err) {
      if (err instanceof PlanRunCampaignNotFound) throw new CampaignNotFoundError(campaignId);
      throw err;
    }
  }

  async summary(campaignId: number): Promise<CampaignSummary | null> {
    const { rows: campaigns } = await this.pool.query<{
      id: number;
      name: string;
      start_date: string;
      end_date: string;
      planned_at: Date | null;
    }>('SELECT id, name, start_date, end_date, planned_at FROM campaigns WHERE id = $1', [campaignId]);
    const campaign = campaigns[0];
    if (!campaign) return null;

    // Counts come from the transactional projection (O(branches × statuses) rows); first/last
    // slots are two index probes per branch on the (campaign, branch, scheduled_at) slot index.
    const [branchRows, countRows] = await Promise.all([
      this.pool.query<{
        id: number;
        name: string;
        time_zone: string;
        earliest: Date | null;
        latest: Date | null;
      }>(
        `SELECT b.id, b.name, b.time_zone,
                (SELECT min(s.scheduled_at) FROM sends s
                  WHERE s.campaign_id = cb.campaign_id AND s.branch_id = b.id AND s.scheduled_at IS NOT NULL) AS earliest,
                (SELECT max(s.scheduled_at) FROM sends s
                  WHERE s.campaign_id = cb.campaign_id AND s.branch_id = b.id AND s.scheduled_at IS NOT NULL) AS latest
           FROM campaign_branches cb
           JOIN branches b ON b.id = cb.branch_id
          WHERE cb.campaign_id = $1
          ORDER BY b.id`,
        [campaignId],
      ),
      this.pool.query<{ branch_id: number; status: SendStatus; count: number }>(
        `SELECT branch_id, status, count FROM campaign_branch_status_counts WHERE campaign_id = $1 AND count <> 0`,
        [campaignId],
      ),
    ]);

    const totals = { ...zeroCounts(), total: 0 };
    const branches: BranchSummary[] = branchRows.rows.map((b) => ({
      id: b.id,
      name: b.name,
      timeZone: b.time_zone,
      total: 0,
      counts: zeroCounts(),
      earliestScheduledAt: iso(b.earliest),
      latestScheduledAt: iso(b.latest),
    }));
    const byId = new Map(branches.map((b) => [b.id, b]));
    for (const row of countRows.rows) {
      const branch = byId.get(row.branch_id);
      if (!branch) continue;
      branch.counts[row.status] += row.count;
      branch.total += row.count;
      totals[row.status] += row.count;
      totals.total += row.count;
    }

    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        startDate: campaign.start_date,
        endDate: campaign.end_date,
        plannedAt: iso(campaign.planned_at),
      },
      totals,
      branches,
    };
  }

  async exists(campaignId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM campaigns WHERE id = $1', [campaignId]);
    return rowCount === 1;
  }

  /** Keyset page ordered by send id; filters map onto the (campaign, [branch,] [status,] id) indexes. */
  async listSends(campaignId: number, query: ListSendsQuery): Promise<{ items: SendRow[]; nextCursor: string | null }> {
    const where = ['s.campaign_id = $1'];
    const params: unknown[] = [campaignId];
    if (query.branchId !== undefined) {
      params.push(query.branchId);
      where.push(`s.branch_id = $${params.length}`);
    }
    if (query.status !== undefined) {
      params.push(query.status);
      where.push(`s.status = $${params.length}`);
    }
    if (query.cursor !== undefined) {
      params.push(query.cursor);
      where.push(`s.id > $${params.length}`);
    }
    params.push(query.limit + 1);

    const { rows } = await this.pool.query<{
      id: number;
      campaign_id: number;
      member_id: number;
      branch_id: number;
      member_name: string;
      phone: string;
      status: SendStatus;
      scheduled_at: Date | null;
      updated_at: Date;
      status_version: number;
    }>(
      `SELECT s.id, s.campaign_id, s.member_id, s.branch_id, m.name AS member_name, m.phone,
              s.status, s.scheduled_at, s.updated_at, s.status_version
         FROM sends s
         JOIN members m ON m.id = s.member_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.id
        LIMIT $${params.length}`,
      params,
    );

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: page.map((r) => ({
        id: r.id,
        campaignId: r.campaign_id,
        memberId: r.member_id,
        branchId: r.branch_id,
        memberName: r.member_name,
        phone: r.phone,
        status: r.status,
        scheduledAt: iso(r.scheduled_at),
        updatedAt: r.updated_at.toISOString(),
        statusVersion: r.status_version,
      })),
      nextCursor: hasMore ? String(page[page.length - 1].id) : null,
    };
  }
}
