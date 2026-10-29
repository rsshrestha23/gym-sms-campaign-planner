-- migrate:no-transaction
-- Built CONCURRENTLY so they don't block writes to large live tables during a rolling deploy.
-- Every statement is idempotent; if a concurrent build fails it leaves an INVALID index that must
-- be dropped before re-running (see docs/production-runbook.md).

-- Due-send scan: planned + waiting, ordered by slot.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sends_due_idx
  ON sends (scheduled_at, id) WHERE status = 'planned' AND dispatch_state = 'waiting';

-- Reconciliation scan for in-flight dispatches.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sends_inflight_idx
  ON sends (dispatch_state, scheduled_at) WHERE dispatch_state IN ('queued', 'claimed', 'retry_wait');

CREATE INDEX CONCURRENTLY IF NOT EXISTS sends_dead_letter_idx
  ON sends (campaign_id, id) WHERE dispatch_state = 'dead_letter';

CREATE INDEX CONCURRENTLY IF NOT EXISTS send_outbox_pending_idx
  ON send_outbox (available_at, id) WHERE published_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS send_outbox_send_idx
  ON send_outbox (send_id, dispatch_generation);

CREATE INDEX CONCURRENTLY IF NOT EXISTS status_event_outbox_pending_idx
  ON status_event_outbox (id) WHERE published_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS send_attempts_finished_idx
  ON send_attempts (finished_at) WHERE finished_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS provider_event_applications_processed_idx
  ON provider_event_applications (processed_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS provider_event_applications_send_idx
  ON provider_event_applications (send_id);
