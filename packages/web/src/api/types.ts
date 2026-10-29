export const SEND_STATUSES = [
  'planned',
  'sent',
  'delivered',
  'undelivered',
  'failed',
  'skipped_opt_out',
  'not_scheduled',
] as const;
export type SendStatus = (typeof SEND_STATUSES)[number];
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

export interface SendItem {
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

export interface SendsPage {
  items: SendItem[];
  nextCursor: string | null;
}

/** Payload of the `send.updated` SSE event. */
export interface SendStatusChanged {
  campaignId: number;
  sendId: number;
  branchId: number;
  status: SendStatus;
  scheduledAt: string | null;
  updatedAt: string;
  statusVersion: number;
}

export function zeroCounts(): StatusCounts {
  return Object.fromEntries(SEND_STATUSES.map((s) => [s, 0])) as StatusCounts;
}

export interface PlanRunBranch {
  branchId: number;
  audienceRows: number;
  planned: number;
  skippedOptOut: number;
  notScheduled: number;
  completedAt: string | null;
}

export interface PlanRun {
  id: number;
  campaignId: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  expectedRows: number;
  processedRows: number;
  error: string | null;
  branches: PlanRunBranch[];
}

export interface BranchCapacity {
  branchId: number;
  audience: number;
  optedOut: number;
  eligible: number;
  slots: number;
  projectedPlanned: number;
  projectedNotScheduled: number;
}

export interface CapacityReport {
  campaignId: number;
  source: 'snapshot' | 'live_members';
  branches: BranchCapacity[];
  totals: Omit<BranchCapacity, 'branchId'> & { unscheduledShare: number };
}
