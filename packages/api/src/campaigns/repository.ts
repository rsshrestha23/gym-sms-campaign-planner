import { Pool } from 'pg';
import { withTransaction } from '../db/pool';
import { SEND_STATUSES, SendStatus } from '../sends/status-transition';
import { planBranch } from './planner';

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
  constructor(private readonly pool: Pool) {}

  /**
   * Plans the campaign at most once. The campaign row lock serializes concurrent callers; the
   * first commits every send row and planned_at together, later callers see planned_at and
   * return the persisted plan untouched. Unique keys on (campaign, member) and
   * (campaign, branch, slot) are the final guards.
   */
  async plan(campaignId: number): Promise<PlanResult> {
    const created = await withTransaction(this.pool, async (client) => {
      const { rows: campaigns } = await client.query<{
        start_date: string;
        end_date: string;
        planned_at: Date | null;
      }>('SELECT start_date, end_date, planned_at FROM campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
      const campaign = campaigns[0];
      if (!campaign) throw new CampaignNotFoundError(campaignId);
      if (campaign.planned_at) return false;

      // One statement, so one consistent membership snapshot across every branch.
      const { rows: members } = await client.query<{
        branch_id: number;
        time_zone: string;
        member_id: number;
        sms_opt_out: boolean;
      }>(
        `SELECT b.id AS branch_id, b.time_zone, m.id AS member_id, m.sms_opt_out
           FROM campaign_branches cb
           JOIN branches b ON b.id = cb.branch_id
           JOIN members m ON m.branch_id = b.id
          WHERE cb.campaign_id = $1
          ORDER BY b.id, m.id`,
        [campaignId],
      );

      const byBranch = new Map<number, { timeZone: string; members: { id: number; smsOptOut: boolean }[] }>();
      for (const row of members) {
        let branch = byBranch.get(row.branch_id);
        if (!branch) byBranch.set(row.branch_id, (branch = { timeZone: row.time_zone, members: [] }));
        branch.members.push({ id: row.member_id, smsOptOut: row.sms_opt_out });
      }

      const branchIds: number[] = [];
      const memberIds: number[] = [];
      const statuses: string[] = [];
      const scheduled: (string | null)[] = [];
      for (const [branchId, branch] of byBranch) {
        for (const send of planBranch({
          members: branch.members,
          timeZone: branch.timeZone,
          startDate: campaign.start_date,
          endDate: campaign.end_date,
        })) {
          branchIds.push(branchId);
          memberIds.push(send.memberId);
          statuses.push(send.status);
          scheduled.push(send.scheduledAt);
        }
      }

      await client.query(
        `INSERT INTO sends (campaign_id, branch_id, member_id, status, scheduled_at)
         SELECT $1, branch_id, member_id, status, scheduled_at
           FROM unnest($2::int[], $3::int[], $4::text[], $5::timestamptz[])
                WITH ORDINALITY AS t(branch_id, member_id, status, scheduled_at, ord)
          ORDER BY ord`,
        [campaignId, branchIds, memberIds, statuses, scheduled],
      );
      await client.query('UPDATE campaigns SET planned_at = now() WHERE id = $1', [campaignId]);
      return true;
    });

    const summary = await this.summary(campaignId);
    return { created, summary: summary! };
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

    const [branchRows, countRows] = await Promise.all([
      this.pool.query<{
        id: number;
        name: string;
        time_zone: string;
        earliest: Date | null;
        latest: Date | null;
      }>(
        `SELECT b.id, b.name, b.time_zone, min(s.scheduled_at) AS earliest, max(s.scheduled_at) AS latest
           FROM campaign_branches cb
           JOIN branches b ON b.id = cb.branch_id
           LEFT JOIN sends s ON s.campaign_id = cb.campaign_id AND s.branch_id = b.id
          WHERE cb.campaign_id = $1
          GROUP BY b.id
          ORDER BY b.id`,
        [campaignId],
      ),
      this.pool.query<{ branch_id: number; status: SendStatus; count: number }>(
        `SELECT branch_id, status, count(*) AS count FROM sends
          WHERE campaign_id = $1 GROUP BY branch_id, status`,
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
