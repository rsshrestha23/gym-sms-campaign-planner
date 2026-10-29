export const PROVIDER_STATUSES = ['sent', 'delivered', 'undelivered', 'failed'] as const;
export const FINAL_STATUSES = ['delivered', 'undelivered', 'failed'] as const;
export const SEND_STATUSES = [
  'planned',
  'sent',
  'delivered',
  'undelivered',
  'failed',
  'skipped_opt_out',
  'not_scheduled',
] as const;

export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];
export type FinalStatus = (typeof FINAL_STATUSES)[number];
export type SendStatus = (typeof SEND_STATUSES)[number];

export function isFinalStatus(status: string): status is FinalStatus {
  return (FINAL_STATUSES as readonly string[]).includes(status);
}

export function isProviderStatus(status: string): status is ProviderStatus {
  return (PROVIDER_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether a provider event may move a send from `current` to `next`.
 * planned -> sent | final; sent -> final; everything else (including same-status) is not a transition.
 * Mirrors the WHERE clause in the webhook UPDATE and the sends_guard_transition trigger.
 */
export function canTransition(current: SendStatus, next: ProviderStatus): boolean {
  if (current === 'planned') return true;
  if (current === 'sent') return isFinalStatus(next);
  return false;
}
