import { describe, expect, it } from 'vitest';
import { generateSlots, planBranch } from '../src/campaigns/planner';
import { BRANCHES, buildMembers } from '../src/seed/data';

const START = '2026-10-23';
const END = '2026-10-29';

const members = (n: number, optedOut: number[] = [], firstId = 1) =>
  Array.from({ length: n }, (_, i) => ({ id: firstId + i, smsOptOut: optedOut.includes(firstId + i) }));

describe('generateSlots', () => {
  it('has 330 slots per day from 09:00 to 19:58 local, Monday to Saturday only', () => {
    const slots = generateSlots('Asia/Kathmandu', START, END);
    expect(slots).toHaveLength(6 * 330);
    const localDays = new Set(
      slots.map((s) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu', dateStyle: 'short' }).format(new Date(s))),
    );
    expect([...localDays].sort()).toEqual(['2026-10-23', '2026-10-24', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']);
    expect(localDays.has('2026-10-25')).toBe(false); // Sunday
  });

  it('starts at 09:00 local, steps two minutes, and ends at 19:58 (no 20:00 slot)', () => {
    const slots = generateSlots('UTC', '2026-10-26', '2026-10-26');
    expect(slots[0]).toBe('2026-10-26T09:00:00.000Z');
    expect(slots[1]).toBe('2026-10-26T09:02:00.000Z');
    expect(slots[slots.length - 1]).toBe('2026-10-26T19:58:00.000Z');
    expect(slots).not.toContain('2026-10-26T20:00:00.000Z');
    expect(slots).toHaveLength(330);
  });

  it('excludes a lone Sunday entirely', () => {
    expect(generateSlots('Europe/London', '2026-10-25', '2026-10-25')).toEqual([]);
  });

  it('pins London across the 2026-10-25 DST change', () => {
    const slots = generateSlots('Europe/London', START, END);
    expect(slots[0]).toBe('2026-10-23T08:00:00.000Z'); // Fri 09:00 BST
    expect(slots[1]).toBe('2026-10-23T08:02:00.000Z'); // Fri 09:02 BST
    expect(slots).toContain('2026-10-26T09:00:00.000Z'); // Mon 09:00 GMT
    expect(slots).not.toContain('2026-10-26T08:00:00.000Z');
    expect(slots[slots.length - 1]).toBe('2026-10-29T19:58:00.000Z'); // Thu 19:58 GMT
  });

  it('pins Sydney (AEDT, UTC+11) and Kathmandu (UTC+5:45)', () => {
    const sydney = generateSlots('Australia/Sydney', START, END);
    expect(sydney[0]).toBe('2026-10-22T22:00:00.000Z');
    expect(sydney[sydney.length - 1]).toBe('2026-10-29T08:58:00.000Z');

    const kathmandu = generateSlots('Asia/Kathmandu', START, END);
    expect(kathmandu[0]).toBe('2026-10-23T03:15:00.000Z');
    expect(kathmandu[329]).toBe('2026-10-23T14:13:00.000Z');
  });
});

describe('planBranch', () => {
  it('assigns slots in member-ID order and skips opted-out members without consuming a slot', () => {
    const result = planBranch({ members: members(5, [2, 4]).reverse(), timeZone: 'UTC', startDate: '2026-10-26', endDate: '2026-10-26' });
    expect(result).toEqual([
      { memberId: 1, status: 'planned', scheduledAt: '2026-10-26T09:00:00.000Z' },
      { memberId: 2, status: 'skipped_opt_out', scheduledAt: null },
      { memberId: 3, status: 'planned', scheduledAt: '2026-10-26T09:02:00.000Z' },
      { memberId: 4, status: 'skipped_opt_out', scheduledAt: null },
      { memberId: 5, status: 'planned', scheduledAt: '2026-10-26T09:04:00.000Z' },
    ]);
  });

  it('marks members beyond capacity as not_scheduled', () => {
    const result = planBranch({ members: members(332), timeZone: 'UTC', startDate: '2026-10-26', endDate: '2026-10-26' });
    expect(result.filter((r) => r.status === 'planned')).toHaveLength(330);
    expect(result.slice(330)).toEqual([
      { memberId: 331, status: 'not_scheduled', scheduledAt: null },
      { memberId: 332, status: 'not_scheduled', scheduledAt: null },
    ]);
  });

  it('produces the expected per-branch totals for the seeded campaign', () => {
    const all = buildMembers();
    const tally = BRANCHES.map((b) => {
      const plan = planBranch({
        members: all.filter((m) => m.branchId === b.id),
        timeZone: b.timeZone,
        startDate: START,
        endDate: END,
      });
      expect(new Set(plan.filter((p) => p.scheduledAt).map((p) => p.scheduledAt)).size).toBe(
        plan.filter((p) => p.scheduledAt).length,
      );
      const by = (s: string) => plan.filter((p) => p.status === s).length;
      return [b.name, by('planned'), by('not_scheduled'), by('skipped_opt_out')];
    });
    expect(tally).toEqual([
      ['London Central', 1980, 120, 100],
      ['Kathmandu Durbar', 1330, 0, 70],
      ['Sydney Harbour', 1330, 0, 70],
    ]);
  });

  it('is deterministic', () => {
    const input = { members: members(400, [7, 50]), timeZone: 'Europe/London', startDate: START, endDate: END };
    expect(planBranch(input)).toEqual(planBranch(input));
  });
});
