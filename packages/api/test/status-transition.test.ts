import { describe, expect, it } from 'vitest';
import { canTransition } from '../src/sends/status-transition';

describe('canTransition', () => {
  it('allows planned -> sent and planned -> any final', () => {
    expect(canTransition('planned', 'sent')).toBe(true);
    expect(canTransition('planned', 'delivered')).toBe(true);
    expect(canTransition('planned', 'undelivered')).toBe(true);
    expect(canTransition('planned', 'failed')).toBe(true);
  });

  it('allows sent -> final but not sent -> sent', () => {
    expect(canTransition('sent', 'delivered')).toBe(true);
    expect(canTransition('sent', 'failed')).toBe(true);
    expect(canTransition('sent', 'sent')).toBe(false);
  });

  it('keeps final statuses terminal', () => {
    for (const final of ['delivered', 'undelivered', 'failed'] as const) {
      expect(canTransition(final, 'sent')).toBe(false);
      for (const other of ['delivered', 'undelivered', 'failed'] as const) expect(canTransition(final, other)).toBe(false);
    }
  });

  it('never moves non-provider statuses', () => {
    expect(canTransition('skipped_opt_out', 'sent')).toBe(false);
    expect(canTransition('not_scheduled', 'delivered')).toBe(false);
  });
});
