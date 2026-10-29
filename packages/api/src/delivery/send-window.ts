import { DateTime } from 'luxon';
import { SLOT_LAST_MINUTE, SLOT_START_MINUTE } from '../campaigns/planner';

/** Sends may leave in [09:00, 20:00) local, Monday–Saturday: the slot window plus the last slot's 2 minutes. */
const WINDOW_END_MINUTE = SLOT_LAST_MINUTE + 2;
const SUNDAY = 7;

export function isWithinSendWindow(now: Date, timeZone: string): boolean {
  const local = DateTime.fromJSDate(now, { zone: timeZone });
  if (local.weekday === SUNDAY) return false;
  const minute = local.hour * 60 + local.minute;
  return minute >= SLOT_START_MINUTE && minute < WINDOW_END_MINUTE;
}

export type SlotVerdict = 'early' | 'send' | 'missed';

/**
 * The approved missed-slot policy: a due send may go out only inside its branch's local window
 * and no later than `graceMs` after its slot. Anything later is `missed` and is marked
 * not_scheduled with an operator alert, never sent late or outside the window.
 */
export function slotVerdict(scheduledAt: Date, now: Date, timeZone: string, graceMs: number): SlotVerdict {
  if (now < scheduledAt) return 'early';
  if (now.getTime() - scheduledAt.getTime() > graceMs) return 'missed';
  return isWithinSendWindow(now, timeZone) ? 'send' : 'missed';
}

export const DEFAULT_MISSED_SLOT_GRACE_MS = 10 * 60_000;
