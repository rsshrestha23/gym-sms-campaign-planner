import { SendItem, SendStatus, SendStatusChanged, StatusCounts, zeroCounts } from '../api/types';

export interface RowFilters {
  branchId: number | null;
  status: SendStatus | null;
}

/**
 * Mutable client cache of every send, keyed by id, plus per-branch status counts.
 *
 * Live updates and snapshot rows are merged by statusVersion, so their arrival order does not
 * matter: an older page response never overwrites a newer live update, and a live update for a
 * row whose page has not arrived yet is held in `pending` until it does. Counts move by deltas
 * derived from the cached row's previous status, and are recomputed when a snapshot lands.
 */
export class LiveStore {
  private rows = new Map<number, SendItem>();
  private ids: number[] = [];
  private pending = new Map<number, SendStatusChanged>();
  private counts = new Map<number, StatusCounts>();
  /** Bumped on every visible change; React reads it to know when to re-derive. */
  version = 0;
  appliedEvents = 0;

  get size(): number {
    return this.rows.size;
  }

  get(id: number): SendItem | undefined {
    return this.rows.get(id);
  }

  /** Returns true when the update changed a cached row. */
  applyUpdate(update: SendStatusChanged): boolean {
    const row = this.rows.get(update.sendId);
    if (!row) {
      const held = this.pending.get(update.sendId);
      if (!held || held.statusVersion < update.statusVersion) this.pending.set(update.sendId, update);
      return false;
    }
    if (update.statusVersion <= row.statusVersion) return false;

    const counts = this.branchCounts(row.branchId);
    counts[row.status]--;
    counts[update.status]++;
    this.rows.set(row.id, { ...row, status: update.status, updatedAt: update.updatedAt, statusVersion: update.statusVersion });
    this.appliedEvents++;
    this.version++;
    return true;
  }

  /**
   * Merges a complete snapshot. With `replace`, cached rows are discarded first (used when the
   * plan itself changed, e.g. after a reset, so stale higher versions cannot win).
   */
  loadSnapshot(items: SendItem[], { replace = false }: { replace?: boolean } = {}): void {
    const previous = replace ? new Map<number, SendItem>() : this.rows;
    const next = new Map<number, SendItem>();
    for (const item of items) {
      let row = item;
      const cached = previous.get(item.id);
      if (cached && cached.statusVersion > row.statusVersion) row = cached;
      const held = this.pending.get(item.id);
      if (held && held.statusVersion > row.statusVersion) {
        row = { ...row, status: held.status, updatedAt: held.updatedAt, statusVersion: held.statusVersion };
      }
      next.set(row.id, row);
    }
    for (const id of next.keys()) this.pending.delete(id);
    if (replace) this.pending.clear();

    this.rows = next;
    this.ids = [...next.keys()].sort((a, b) => a - b);
    this.recount();
    this.version++;
  }

  clear(): void {
    this.rows.clear();
    this.ids = [];
    this.pending.clear();
    this.counts.clear();
    this.version++;
  }

  /** Copy of the per-branch counts, safe to hand to React. */
  countsSnapshot(): Record<number, StatusCounts> {
    const out: Record<number, StatusCounts> = {};
    for (const [branchId, counts] of this.counts) out[branchId] = { ...counts };
    return out;
  }

  filtered({ branchId, status }: RowFilters): SendItem[] {
    const out: SendItem[] = [];
    for (const id of this.ids) {
      const row = this.rows.get(id)!;
      if (branchId !== null && row.branchId !== branchId) continue;
      if (status !== null && row.status !== status) continue;
      out.push(row);
    }
    return out;
  }

  private branchCounts(branchId: number): StatusCounts {
    let counts = this.counts.get(branchId);
    if (!counts) this.counts.set(branchId, (counts = zeroCounts()));
    return counts;
  }

  private recount(): void {
    this.counts.clear();
    for (const row of this.rows.values()) this.branchCounts(row.branchId)[row.status]++;
  }
}
