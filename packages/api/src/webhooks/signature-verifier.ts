import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-provider-signature';
export const TIMESTAMP_HEADER = 'x-provider-timestamp';

export interface SigningKey {
  /** Label stored with the receipt (e.g. "current", "previous") to track rotation progress. */
  id: string;
  secret: string;
}

export type VerifyResult =
  | { ok: true; keyId: string }
  | { ok: false; reason: 'missing_signature' | 'bad_timestamp' | 'stale_timestamp' | 'signature_mismatch' };

/**
 * HMAC-SHA256 webhook signatures (provider-neutral; the selected vendor's exact scheme replaces
 * the header parsing, not the rules):
 *   X-Provider-Timestamp: <unix seconds>
 *   X-Provider-Signature: v1=<hex hmac(secret, `${timestamp}.${rawBody}`)>[, v1=<hex> ...]
 * The timestamp is inside the MAC and must be within `toleranceSec` of our clock, which bounds
 * replays; replays inside the window are also deduped by eventId. Several keys are accepted at once
 * so secrets can be rotated without dropping webhooks (current first, then previous).
 */
export function verifySignature(
  rawBody: Buffer,
  headers: { signature?: string; timestamp?: string },
  keys: SigningKey[],
  { toleranceSec = 300, nowMs = Date.now() }: { toleranceSec?: number; nowMs?: number } = {},
): VerifyResult {
  if (!headers.signature || !headers.timestamp) return { ok: false, reason: 'missing_signature' };
  if (!/^\d{9,11}$/.test(headers.timestamp)) return { ok: false, reason: 'bad_timestamp' };
  const ts = Number(headers.timestamp);
  if (Math.abs(nowMs / 1000 - ts) > toleranceSec) return { ok: false, reason: 'stale_timestamp' };

  const provided = headers.signature
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .map((part) => Buffer.from(part.slice(3), 'hex'))
    .filter((buf) => buf.length === 32);

  for (const key of keys) {
    const expected = createHmac('sha256', key.secret).update(`${headers.timestamp}.`).update(rawBody).digest();
    if (provided.some((sig) => timingSafeEqual(sig, expected))) return { ok: true, keyId: key.id };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

/** Produces headers for a signed request (used by the simulator and the mock provider). */
export function signRequest(rawBody: string | Buffer, secret: string, nowMs = Date.now()): Record<string, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  const mac = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: `v1=${mac}` };
}

/**
 * Parses WEBHOOK_SIGNING_SECRETS: comma-separated secrets, newest first (the first is labelled
 * "current", later ones "previous", "previous-2", ...). Secret managers can mount a file instead
 * via WEBHOOK_SIGNING_SECRETS_FILE.
 */
export function parseSigningKeys(raw: string | undefined): SigningKey[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((secret, i) => ({ id: i === 0 ? 'current' : i === 1 ? 'previous' : `previous-${i}`, secret }));
}
