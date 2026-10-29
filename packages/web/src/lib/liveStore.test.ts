import { describe, expect, it } from 'vitest';
import type { SendItem, SendStatus } from '../api/types';
import { LiveStore } from './liveStore';

const row = (id: number, branchId: number, status: SendStatus = 'planned', statusVersion = 1): SendItem => ({
  id, campaignId: 1, memberId: id, branchId, memberName: `M${id}`, phone: `+${id}`, status,
  scheduledAt: status === 'planned' ? '2026-10-23T08:00:00.000Z' : null, updatedAt: '2026-10-29T00:00:00.000Z', statusVersion,
});
const upd = (sendId: number, branchId: number, status: SendStatus, statusVersion: number) => ({
  campaignId: 1, sendId, branchId, status, statusVersion, scheduledAt: null, updatedAt: `2026-10-29T00:00:0${statusVersion}.000Z`,
});

describe('LiveStore', () => {
  it('recounts per branch from a snapshot', () => {
    const s = new LiveStore();
    s.loadSnapshot([row(1, 1), row(2, 1, 'skipped_opt_out'), row(3, 2)]);
    expect(s.countsSnapshot()[1]).toMatchObject({ planned: 1, skipped_opt_out: 1 });
    expect(s.countsSnapshot()[2]).toMatchObject({ planned: 1 });
  });

  it('moves counts by deltas derived from the cached row', () => {
    const s = new LiveStore();
    s.loadSnapshot([row(1, 1), row(2, 1)]);
    expect(s.applyUpdate(upd(1, 1, 'sent', 2))).toBe(true);
    expect(s.applyUpdate(upd(1, 1, 'delivered', 3))).toBe(true);
    expect(s.countsSnapshot()[1]).toMatchObject({ planned: 1, sent: 0, delivered: 1 });
    expect(s.get(1)).toMatchObject({ status: 'delivered', statusVersion: 3 });
  });

  it('ignores duplicate and out-of-order updates', () => {
    const s = new LiveStore();
    s.loadSnapshot([row(1, 1)]);
    s.applyUpdate(upd(1, 1, 'failed', 3));
    expect(s.applyUpdate(upd(1, 1, 'sent', 2))).toBe(false);
    expect(s.applyUpdate(upd(1, 1, 'failed', 3))).toBe(false);
    expect(s.countsSnapshot()[1]).toMatchObject({ planned: 0, sent: 0, failed: 1 });
  });

  it('holds updates for rows not loaded yet and applies them when the snapshot lands', () => {
    const s = new LiveStore();
    expect(s.applyUpdate(upd(5, 2, 'sent', 2))).toBe(false);
    expect(s.applyUpdate(upd(5, 2, 'delivered', 3))).toBe(false);
    s.loadSnapshot([row(5, 2)]);
    expect(s.get(5)).toMatchObject({ status: 'delivered', statusVersion: 3 });
    expect(s.countsSnapshot()[2]).toMatchObject({ planned: 0, delivered: 1 });
  });

  it('keeps a newer cached row over an older snapshot response', () => {
    const s = new LiveStore();
    s.loadSnapshot([row(1, 1)]);
    s.applyUpdate(upd(1, 1, 'sent', 2));
    s.loadSnapshot([row(1, 1, 'planned', 1)]); // stale page
    expect(s.get(1)).toMatchObject({ status: 'sent', statusVersion: 2 });
    s.loadSnapshot([row(1, 1, 'undelivered', 3)]); // newer page wins
    expect(s.get(1)).toMatchObject({ status: 'undelivered', statusVersion: 3 });
    expect(s.countsSnapshot()[1]).toMatchObject({ sent: 0, undelivered: 1 });
  });

  it('replaces wholesale when the plan changed', () => {
    const s = new LiveStore();
    s.loadSnapshot([row(1, 1, 'delivered', 3)]);
    s.loadSnapshot([row(1, 1, 'planned', 1)], { replace: true });
    expect(s.get(1)).toMatchObject({ status: 'planned', statusVersion: 1 });
  });

  it('filters by branch and status in id order', () => {
    const s = new LiveStore();
    s.loadSnapshot([row(3, 2), row(1, 1), row(2, 1, 'skipped_opt_out')]);
    expect(s.filtered({ branchId: null, status: null }).map((r) => r.id)).toEqual([1, 2, 3]);
    expect(s.filtered({ branchId: 1, status: null }).map((r) => r.id)).toEqual([1, 2]);
    expect(s.filtered({ branchId: 1, status: 'planned' }).map((r) => r.id)).toEqual([1]);
    s.applyUpdate(upd(3, 2, 'failed', 2));
    expect(s.filtered({ branchId: null, status: 'failed' }).map((r) => r.id)).toEqual([3]);
  });
});
