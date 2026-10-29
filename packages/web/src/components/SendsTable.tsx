import { memo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SendItem } from '../api/types';
import { formatInZone } from '../lib/format';
import { StatusBadge } from './StatusBadge';

interface Props {
  rows: SendItem[];
  branches: Map<number, { name: string; timeZone: string }>;
  viewerZone: string;
  /** More sends match than were loaded (large campaigns load a bounded, server-filtered window). */
  truncated?: boolean;
}

const ROW_HEIGHT = 44;

/** Renders only the visible window of the (up to 5,000-row) snapshot. */
export function SendsTable({ rows, branches, viewerZone, truncated = false }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => rows[index].id,
  });

  return (
    <div className="table" role="table" aria-label="Campaign sends" aria-rowcount={rows.length}>
      <div className="tr thead" role="row">
        <span role="columnheader">Send</span>
        <span role="columnheader">Member</span>
        <span role="columnheader">Branch</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Scheduled (branch)</span>
        <span role="columnheader">Scheduled (you)</span>
        <span role="columnheader">Updated (you)</span>
      </div>
      <div ref={scrollRef} className="tbody">
        {rows.length === 0 ? (
          <p className="empty">No sends match these filters.</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index];
              return (
                <Row
                  key={row.id}
                  row={row}
                  top={v.start}
                  branch={branches.get(row.branchId)}
                  viewerZone={viewerZone}
                />
              );
            })}
          </div>
        )}
      </div>
      {truncated && (
        <p className="truncated" role="status">
          Showing the first {rows.length.toLocaleString()} matching sends. Narrow the branch or status filter to see others;
          counts above cover the whole campaign.
        </p>
      )}
    </div>
  );
}

// Row props are stable unless that send changed, so a live update re-renders one row, not the table.
const Row = memo(function Row({
  row,
  top,
  branch,
  viewerZone,
}: {
  row: SendItem;
  top: number;
  branch: { name: string; timeZone: string } | undefined;
  viewerZone: string;
}) {
  return (
    <div className="tr" role="row" style={{ transform: `translateY(${top}px)`, height: ROW_HEIGHT }}>
      <span role="cell" className="mono">#{row.id}</span>
      <span role="cell" className="member">
        <span>{row.memberName}</span>
        <span className="muted mono">{row.phone}</span>
      </span>
      <span role="cell">{branch?.name ?? row.branchId}</span>
      <span role="cell">
        <StatusBadge status={row.status} version={row.statusVersion} />
      </span>
      <span role="cell" className="mono">{branch ? formatInZone(row.scheduledAt, branch.timeZone) : '—'}</span>
      <span role="cell" className="mono">{formatInZone(row.scheduledAt, viewerZone)}</span>
      <span role="cell" className="mono muted">{row.statusVersion > 1 ? formatInZone(row.updatedAt, viewerZone) : '—'}</span>
    </div>
  );
});
