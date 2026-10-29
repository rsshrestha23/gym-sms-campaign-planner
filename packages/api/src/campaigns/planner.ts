import { DateTime } from 'luxon';

export interface Member {
  id: number;
  smsOptOut: boolean;
}

export type PlannedStatus = 'planned' | 'skipped_opt_out' | 'not_scheduled';

export interface PlannedSend {
  memberId: number;
  status: PlannedStatus;
  /** ISO-8601 UTC, or null when the member gets no slot. */
  scheduledAt: string | null;
}

export interface PlanBranchInput {
  members: Member[];
  timeZone: string;
  /** Inclusive local calendar dates, YYYY-MM-DD. */
  startDate: string;
  endDate: string;
}

export const SLOT_START_MINUTE = 9 * 60; // 09:00 local
export const SLOT_LAST_MINUTE = 19 * 60 + 58; // 19:58 local; 20:00 is not a slot
export const SLOT_INTERVAL_MINUTES = 2;
const SUNDAY = 7; // Luxon weekday numbering: Monday = 1 … Sunday = 7

/**
 * Every eligible slot for the branch in ascending UTC order: Monday–Saturday, 09:00–19:58 local,
 * every two minutes. Slots are built from local wall-clock dates and converted to UTC, so DST
 * changes inside the range shift the UTC offset rather than the local times.
 */
export function generateSlots(timeZone: string, startDate: string, endDate: string): string[] {
  const start = DateTime.fromISO(startDate, { zone: timeZone });
  const end = DateTime.fromISO(endDate, { zone: timeZone });
  if (!start.isValid || !end.isValid) {
    throw new Error(`Invalid campaign date range ${startDate}..${endDate} in ${timeZone}`);
  }

  const seen = new Set<string>();
  const slots: string[] = [];
  for (let day = start.startOf('day'); day <= end; day = day.plus({ days: 1 })) {
    if (day.weekday === SUNDAY) continue;
    for (let minute = SLOT_START_MINUTE; minute <= SLOT_LAST_MINUTE; minute += SLOT_INTERVAL_MINUTES) {
      const local = DateTime.fromObject(
        { year: day.year, month: day.month, day: day.day, hour: Math.floor(minute / 60), minute: minute % 60 },
        { zone: timeZone },
      );
      // A wall time skipped by a DST jump would be normalized forward; drop it rather than
      // invent a slot the branch never sees. A repeated (fall-back) time maps to one instant.
      if (local.hour * 60 + local.minute !== minute) continue;
      const iso = local.toUTC().toISO({ suppressMilliseconds: false })!;
      if (seen.has(iso)) continue;
      seen.add(iso);
      slots.push(iso);
    }
  }
  return slots.sort();
}

/**
 * One result per member, in member-ID order. Opted-out members are skipped without consuming a
 * slot; the rest take the earliest free slots in ascending member ID; any remainder is not_scheduled.
 */
export function planBranch(input: PlanBranchInput): PlannedSend[] {
  const slots = generateSlots(input.timeZone, input.startDate, input.endDate);
  const members = [...input.members].sort((a, b) => a.id - b.id);
  let next = 0;
  return members.map((member): PlannedSend => {
    if (member.smsOptOut) return { memberId: member.id, status: 'skipped_opt_out', scheduledAt: null };
    if (next < slots.length) return { memberId: member.id, status: 'planned', scheduledAt: slots[next++] };
    return { memberId: member.id, status: 'not_scheduled', scheduledAt: null };
  });
}
