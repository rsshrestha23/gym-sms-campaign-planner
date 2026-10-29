import { memo } from 'react';
import { BranchSummary as BranchSummaryData, SEND_STATUSES, StatusCounts } from '../api/types';
import { formatInZone, STATUS_LABELS } from '../lib/format';

interface Props {
  branch: BranchSummaryData;
  counts: StatusCounts | undefined;
  viewerZone: string;
  selected: boolean;
  onSelect: (branchId: number | null) => void;
}

export const BranchSummary = memo(function BranchSummary({ branch, counts, viewerZone, selected, onSelect }: Props) {
  const c = counts ?? branch.counts;
  const total = SEND_STATUSES.reduce((sum, s) => sum + c[s], 0);
  const finished = c.delivered + c.undelivered + c.failed;
  const scheduled = c.planned + c.sent + finished;

  return (
    <section className={`branch-card${selected ? ' selected' : ''}`} aria-label={branch.name}>
      <header>
        <div>
          <h2>{branch.name}</h2>
          <p className="muted">{branch.timeZone}</p>
        </div>
        <button type="button" className="link" onClick={() => onSelect(selected ? null : branch.id)}>
          {selected ? 'Show all' : 'Filter'}
        </button>
      </header>

      <div className="progress" role="img" aria-label={`${finished} of ${scheduled} scheduled sends finished`}>
        {(['delivered', 'undelivered', 'failed', 'sent'] as const).map((s) =>
          scheduled ? <span key={s} className={`bar bar-${s}`} style={{ width: `${(c[s] / scheduled) * 100}%` }} /> : null,
        )}
      </div>

      <dl className="counts">
        {SEND_STATUSES.map((s) => (
          <div key={s} className={c[s] ? '' : 'zero'}>
            <dt>
              <span className={`dot dot-${s}`} />
              {STATUS_LABELS[s]}
            </dt>
            <dd>{c[s].toLocaleString()}</dd>
          </div>
        ))}
        <div className="total">
          <dt>Total</dt>
          <dd>{total.toLocaleString()}</dd>
        </div>
      </dl>

      <table className="window">
        <thead>
          <tr>
            <th />
            <th>Branch time</th>
            <th>Your time</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>First</th>
            <td>{formatInZone(branch.earliestScheduledAt, branch.timeZone)}</td>
            <td>{formatInZone(branch.earliestScheduledAt, viewerZone)}</td>
          </tr>
          <tr>
            <th>Last</th>
            <td>{formatInZone(branch.latestScheduledAt, branch.timeZone)}</td>
            <td>{formatInZone(branch.latestScheduledAt, viewerZone)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
});
