import { useMemo, useState } from 'react';
import { SEND_STATUSES, SendStatus } from './api/types';
import { BranchSummary } from './components/BranchSummary';
import { SendsTable } from './components/SendsTable';
import { useCampaignLiveData } from './hooks/useCampaignLiveData';
import { STATUS_LABELS, viewerTimeZone } from './lib/format';

const CAMPAIGN_ID = Number(new URLSearchParams(window.location.search).get('campaign') ?? 1);

export function App() {
  const [branchId, setBranchId] = useState<number | null>(null);
  const [status, setStatus] = useState<SendStatus | null>(null);
  const filters = useMemo(() => ({ branchId, status }), [branchId, status]);
  const data = useCampaignLiveData(CAMPAIGN_ID, filters);
  const viewerZone = useMemo(viewerTimeZone, []);
  const [planning, setPlanning] = useState(false);

  const branches = useMemo(
    () => new Map((data.summary?.branches ?? []).map((b) => [b.id, { name: b.name, timeZone: b.timeZone }])),
    [data.summary],
  );
  const campaign = data.summary?.campaign;

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Campaign {CAMPAIGN_ID}</p>
          <h1>{campaign?.name ?? 'Loading campaign…'}</h1>
          {campaign && (
            <p className="muted">
              Local dates {campaign.startDate} → {campaign.endDate} · Mon–Sat 09:00–19:58 branch time, every 2 min ·
              Viewing in <strong>{viewerZone}</strong>
            </p>
          )}
        </div>
        <div className="live">
          <span className={`pill pill-${data.connection}`}>
            <span className="pulse" />
            {data.connection === 'live' ? 'Live' : data.connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
          </span>
          <span className="muted mono">{data.updatesPerSecond} updates/s</span>
        </div>
      </header>

      {data.error && (
        <div className="alert" role="alert">
          {data.error}{' '}
          <button type="button" className="link" onClick={data.refresh}>
            Retry
          </button>
        </div>
      )}

      {campaign && !campaign.plannedAt && (
        <div className="callout">
          <p>
            This campaign has no plan yet. Planning stores one send per member with a calculated slot; it does not send
            anything.
          </p>
          <button
            type="button"
            className="primary"
            disabled={planning}
            onClick={async () => {
              setPlanning(true);
              await data.plan();
              setPlanning(false);
            }}
          >
            {planning ? 'Planning…' : 'Plan campaign'}
          </button>
        </div>
      )}

      <div className="branches">
        {data.summary?.branches.map((b) => (
          <BranchSummary
            key={b.id}
            branch={b}
            counts={data.counts[b.id]}
            viewerZone={viewerZone}
            selected={branchId === b.id}
            onSelect={setBranchId}
          />
        ))}
      </div>

      <section className="sends">
        <div className="toolbar">
          <h2>Sends</h2>
          <label>
            Branch
            <select value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">All branches</option>
              {data.summary?.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select value={status ?? ''} onChange={(e) => setStatus((e.target.value || null) as SendStatus | null)}>
              <option value="">All statuses</option>
              {SEND_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <span className="muted grow-right">
            {data.loading && data.loadedRows === 0
              ? 'Loading sends…'
              : `${data.rows.length.toLocaleString()} of ${data.loadedRows.toLocaleString()} sends`}
          </span>
        </div>
        <SendsTable rows={data.rows} branches={branches} viewerZone={viewerZone} />
      </section>
    </div>
  );
}
