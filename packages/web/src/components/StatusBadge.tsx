import type { SendStatus } from '../api/types';
import { STATUS_LABELS } from '../lib/format';

export function StatusBadge({ status, version }: { status: SendStatus; version?: number }) {
  // Keyed by version so a status change remounts the badge and replays its highlight animation.
  return (
    <span key={version} className={`badge badge-${status}${version && version > 1 ? ' badge-changed' : ''}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}
