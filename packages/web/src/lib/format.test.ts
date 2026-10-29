import { describe, expect, it } from 'vitest';
import { formatInZone } from './format';

describe('formatInZone', () => {
  it('renders UTC instants in an explicit branch zone, across DST', () => {
    expect(formatInZone('2026-10-23T08:00:00.000Z', 'Europe/London')).toMatch(/Fri.*23 Oct.*09:00.*BST/);
    expect(formatInZone('2026-10-26T09:00:00.000Z', 'Europe/London')).toMatch(/Mon.*26 Oct.*09:00.*GMT/);
    expect(formatInZone('2026-10-23T03:15:00.000Z', 'Asia/Kathmandu')).toMatch(/23 Oct.*09:00.*GMT\+5:45/);
    expect(formatInZone('2026-10-22T22:00:00.000Z', 'Australia/Sydney')).toMatch(/Fri.*23 Oct.*09:00/);
  });

  it('renders the same instant differently for a different viewer zone', () => {
    expect(formatInZone('2026-10-22T22:00:00.000Z', 'America/New_York')).toMatch(/Thu.*22 Oct.*18:00/);
  });

  it('renders a dash for unscheduled sends', () => {
    expect(formatInZone(null, 'UTC')).toBe('—');
  });
});
