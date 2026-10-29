export interface BranchSeed {
  id: number;
  name: string;
  timeZone: string;
  memberCount: number;
  optOutCount: number;
}

export interface MemberSeed {
  id: number;
  branchId: number;
  name: string;
  phone: string;
  smsOptOut: boolean;
}

export const BRANCHES: readonly BranchSeed[] = [
  { id: 1, name: 'London Central', timeZone: 'Europe/London', memberCount: 2200, optOutCount: 100 },
  { id: 2, name: 'Kathmandu Durbar', timeZone: 'Asia/Kathmandu', memberCount: 1400, optOutCount: 70 },
  { id: 3, name: 'Sydney Harbour', timeZone: 'Australia/Sydney', memberCount: 1400, optOutCount: 70 },
];

export const CAMPAIGN = {
  id: 1,
  name: 'Win-back October',
  startDate: '2026-10-23',
  endDate: '2026-10-29',
  branchIds: [1, 2, 3],
} as const;

const PHONE_PREFIX: Record<number, string> = { 1: '+447700', 2: '+97798', 3: '+61400' };

const FIRST_NAMES = [
  'Aarav', 'Amelia', 'Bikash', 'Charlotte', 'Dawa', 'Ella', 'Finn', 'Grace', 'Hari', 'Isla',
  'Jack', 'Kiran', 'Liam', 'Maya', 'Noah', 'Olivia', 'Pema', 'Quinn', 'Ruby', 'Sita',
  'Tom', 'Uma', 'Victor', 'Willow', 'Xavier', 'Yash', 'Zoe', 'Anish', 'Bella', 'Chloe',
  'Deepa', 'Ethan',
];
const LAST_NAMES = [
  'Shrestha', 'Smith', 'Gurung', 'Jones', 'Tamang', 'Williams', 'Thapa', 'Brown', 'Rai', 'Taylor',
  'Karki', 'Wilson', 'Magar', 'Evans', 'Adhikari', 'Walker', 'Sherpa', 'Thomas', 'Lama', 'Roberts',
  'Khadka', 'Nguyen', 'Bhandari', 'Martin', 'Poudel', 'Kelly', 'Basnet', 'White', 'Joshi', 'Harris',
  'Pandey',
];

/**
 * True for exactly `optOutCount` of `memberCount` positions, spread evenly through the range
 * (e.g. every 22nd London member).
 */
export function isSpreadOptOut(index: number, memberCount: number, optOutCount: number): boolean {
  return Math.floor(((index + 1) * optOutCount) / memberCount) > Math.floor((index * optOutCount) / memberCount);
}

/** Deterministic members: London 1–2200, Kathmandu 2201–3600, Sydney 3601–5000. */
export function buildMembers(branches: readonly BranchSeed[] = BRANCHES): MemberSeed[] {
  const members: MemberSeed[] = [];
  let nextId = 1;
  for (const branch of branches) {
    for (let i = 0; i < branch.memberCount; i++) {
      const id = nextId++;
      const first = FIRST_NAMES[id % FIRST_NAMES.length];
      // Coprime list lengths (32, 31) make every (first, last) pair distinct for 992 ids; the
      // numeric suffix keeps names globally unique for display and search.
      const last = LAST_NAMES[Math.floor(id / FIRST_NAMES.length) % LAST_NAMES.length];
      members.push({
        id,
        branchId: branch.id,
        name: `${first} ${last} #${id}`,
        phone: `${PHONE_PREFIX[branch.id] ?? '+1555'}${String(id).padStart(6, '0')}`,
        smsOptOut: isSpreadOptOut(i, branch.memberCount, branch.optOutCount),
      });
    }
  }
  return members;
}
