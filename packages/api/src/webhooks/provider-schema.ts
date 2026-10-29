import { z } from 'zod';
import { PROVIDER_STATUSES } from '../sends/status-transition';

export const providerEventSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    sendId: z.number().int().positive().max(2_147_483_647),
    status: z.enum(PROVIDER_STATUSES),
    // ISO-8601 with an explicit offset (Z or ±hh:mm); a bare local time is ambiguous.
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ProviderEvent = z.infer<typeof providerEventSchema>;

export type ParseResult = { ok: true; event: ProviderEvent } | { ok: false; error: string; issues?: unknown };

export function parseProviderEvent(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  const result = providerEventSchema.safeParse(json);
  if (!result.success) return { ok: false, error: 'invalid_payload', issues: result.error.issues };
  return { ok: true, event: result.data };
}
