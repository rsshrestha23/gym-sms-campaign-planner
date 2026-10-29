import type { ProviderStatus } from '../sends/status-transition';

/** A committed send status change. The client derives the prior status from its cached row. */
export interface SendStatusChanged {
  campaignId: number;
  sendId: number;
  branchId: number;
  status: ProviderStatus;
  scheduledAt: string | null;
  updatedAt: string;
  statusVersion: number;
}

export interface SendUpdatePublisher {
  /** Called only after the transaction that produced `update` has committed. */
  publish(update: SendStatusChanged): void;
}

export const noopPublisher: SendUpdatePublisher = { publish: () => undefined };
