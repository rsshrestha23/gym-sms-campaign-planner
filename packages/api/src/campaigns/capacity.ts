import { Pool } from 'pg';
import { generateSlots } from './planner';

export interface BranchCapacity {
  branchId: number;
  name: string;
  timeZone: string;
  audience: number;
  optedOut: number;
  eligible: number;
  slots: number;
  projectedPlanned: number;
  projectedNotScheduled: number;
}

export interface CapacityReport {
  campaignId: number;
  /** 'snapshot' once the audience is frozen; otherwise a projection from current membership. */
  source: 'snapshot' | 'live_members';
  audienceVersion: number | null;
  branches: BranchCapacity[];
  totals: Omit<BranchCapacity, 'branchId' | 'name' | 'timeZone'> & { unscheduledShare: number };
}

/**
 * What a plan will (or did) do before anyone promises reach: per branch, slots available in the
 * campaign window versus eligible members. At 100 branches × ~50k members, this is where the ~96%
 * not_scheduled outcome becomes visible to the business.
 */
export async function capacityReport(pool: Pool, campaignId: number): Promise<CapacityReport | null> {
  const { rows: campaigns } = await pool.query(
    `SELECT start_date, end_date, audience_version FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  const campaign = campaigns[0];
  if (!campaign) return null;
  const fromSnapshot = campaign.audience_version !== null;

  const { rows } = await pool.query<{ id: number; name: string; time_zone: string; audience: number; opted_out: number }>(
    fromSnapshot
      ? `SELECT b.id, b.name, b.time_zone, count(a.member_id)::int AS audience,
                count(*) FILTER (WHERE a.opted_out_at_plan)::int AS opted_out
           FROM campaign_branches cb JOIN branches b ON b.id = cb.branch_id
           LEFT JOIN campaign_audience_members a
             ON a.campaign_id = cb.campaign_id AND a.audience_version = $2 AND a.branch_id = b.id
          WHERE cb.campaign_id = $1 GROUP BY b.id ORDER BY b.id`
      : `SELECT b.id, b.name, b.time_zone, count(m.id)::int AS audience,
                count(*) FILTER (WHERE m.sms_opt_out)::int AS opted_out
           FROM campaign_branches cb JOIN branches b ON b.id = cb.branch_id
           LEFT JOIN members m ON m.branch_id = b.id
          WHERE cb.campaign_id = $1 GROUP BY b.id ORDER BY b.id`,
    fromSnapshot ? [campaignId, campaign.audience_version] : [campaignId],
  );

  const branches = rows.map((b): BranchCapacity => {
    const slots = generateSlots(b.time_zone, campaign.start_date, campaign.end_date).length;
    const eligible = b.audience - b.opted_out;
    const planned = Math.min(eligible, slots);
    return {
      branchId: b.id,
      name: b.name,
      timeZone: b.time_zone,
      audience: b.audience,
      optedOut: b.opted_out,
      eligible,
      slots,
      projectedPlanned: planned,
      projectedNotScheduled: eligible - planned,
    };
  });
  const sum = (k: keyof BranchCapacity) => branches.reduce((n, b) => n + (b[k] as number), 0);
  const eligible = sum('eligible');
  return {
    campaignId,
    source: fromSnapshot ? 'snapshot' : 'live_members',
    audienceVersion: campaign.audience_version,
    branches,
    totals: {
      audience: sum('audience'),
      optedOut: sum('optedOut'),
      eligible,
      slots: sum('slots'),
      projectedPlanned: sum('projectedPlanned'),
      projectedNotScheduled: sum('projectedNotScheduled'),
      unscheduledShare: eligible ? sum('projectedNotScheduled') / eligible : 0,
    },
  };
}
