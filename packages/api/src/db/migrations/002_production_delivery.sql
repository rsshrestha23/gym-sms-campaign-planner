-- Production delivery model (expand phase). Only adds tables/columns and loosens constraints, so
-- instances running the previous release keep working while this release rolls out.
-- Legacy webhook_receipts/provider_events are backfilled below and left in place; a later
-- contract migration drops them once no old instance writes to them.

-- ---------------------------------------------------------------------------------------------
-- Campaign controls and immutable, versioned audience snapshots
-- ---------------------------------------------------------------------------------------------
ALTER TABLE campaigns
  ADD COLUMN audience_version  integer,
  -- Dispatch is opt-in per campaign. Historical/simulated campaigns (like the seeded demo) are
  -- never picked up by the due-send dispatcher.
  ADD COLUMN dispatch_enabled  boolean     NOT NULL DEFAULT false,
  ADD COLUMN paused_at         timestamptz,
  ADD COLUMN cancelled_at      timestamptz,
  -- Rendered per member by the worker; {{firstName}} and {{branchName}} are substituted.
  ADD COLUMN message_template  text        NOT NULL
    DEFAULT 'Hi {{firstName}}, we miss you at {{branchName}}! Come back this week. Reply STOP to opt out.';

CREATE TABLE campaign_audience_versions (
  campaign_id    integer     NOT NULL REFERENCES campaigns (id),
  version        integer     NOT NULL CHECK (version > 0),
  member_count   integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finalized_at   timestamptz,
  PRIMARY KEY (campaign_id, version),
  CHECK ((finalized_at IS NULL) = (member_count IS NULL))
);

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_audience_version_fk
  FOREIGN KEY (id, audience_version) REFERENCES campaign_audience_versions (campaign_id, version);

-- Members as they were when the snapshot was taken. Phone and consent are NOT trusted from here at
-- send time: workers re-read members immediately before calling the provider.
CREATE TABLE campaign_audience_members (
  campaign_id          integer NOT NULL,
  audience_version     integer NOT NULL,
  branch_id            integer NOT NULL,
  member_id            integer NOT NULL,
  time_zone            text    NOT NULL,
  opted_out_at_plan    boolean NOT NULL,
  PRIMARY KEY (campaign_id, audience_version, branch_id, member_id),
  UNIQUE (campaign_id, audience_version, member_id),
  FOREIGN KEY (campaign_id, audience_version) REFERENCES campaign_audience_versions (campaign_id, version),
  FOREIGN KEY (member_id, branch_id) REFERENCES members (id, branch_id)
);

-- A finalized snapshot is immutable; retargeting needs a new campaign revision.
CREATE FUNCTION audience_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_campaign integer := COALESCE(NEW.campaign_id, OLD.campaign_id);
  v_version  integer := COALESCE(NEW.audience_version, OLD.audience_version);
BEGIN
  IF current_setting('app.retention', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF EXISTS (SELECT 1 FROM campaign_audience_versions
              WHERE campaign_id = v_campaign AND version = v_version AND finalized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'audience snapshot %/% is finalized and immutable', v_campaign, v_version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER campaign_audience_members_guard
  BEFORE INSERT OR UPDATE OR DELETE ON campaign_audience_members
  FOR EACH ROW EXECUTE FUNCTION audience_snapshot_guard();

CREATE FUNCTION audience_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.finalized_at IS NOT NULL AND current_setting('app.retention', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'audience snapshot %/% is finalized and immutable', OLD.campaign_id, OLD.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER campaign_audience_versions_guard
  BEFORE UPDATE OR DELETE ON campaign_audience_versions
  FOR EACH ROW EXECUTE FUNCTION audience_version_guard();

-- ---------------------------------------------------------------------------------------------
-- Resumable plan runs
-- ---------------------------------------------------------------------------------------------
CREATE TABLE campaign_plan_runs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id        integer     NOT NULL REFERENCES campaigns (id),
  audience_version   integer     NOT NULL,
  idempotency_key    text        NOT NULL UNIQUE,
  status             text        NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  -- Slots before this instant are never assigned (live campaigns); NULL plans the whole range
  -- (historical/simulated campaigns). Fixed at creation so a resumed run stays deterministic.
  earliest_slot_at   timestamptz,
  chunk_size         integer     NOT NULL CHECK (chunk_size > 0),
  expected_rows      integer     NOT NULL,
  error              text,
  attempts           integer     NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  completed_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, audience_version) REFERENCES campaign_audience_versions (campaign_id, version),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
-- At most one active and at most one completed run per campaign.
CREATE UNIQUE INDEX campaign_plan_runs_one_active ON campaign_plan_runs (campaign_id) WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX campaign_plan_runs_one_completed ON campaign_plan_runs (campaign_id) WHERE status = 'completed';

-- Per-branch checkpoint: everything up to cursor_member_id is committed, with the slot index and
-- status counts reached so far. Updated in the same transaction as the chunk's send rows.
CREATE TABLE campaign_plan_run_branches (
  plan_run_id        bigint  NOT NULL REFERENCES campaign_plan_runs (id),
  branch_id          integer NOT NULL REFERENCES branches (id),
  time_zone          text    NOT NULL,
  audience_rows      integer NOT NULL,
  cursor_member_id   integer NOT NULL DEFAULT 0,
  slots_used         integer NOT NULL DEFAULT 0,
  planned            integer NOT NULL DEFAULT 0,
  skipped_opt_out    integer NOT NULL DEFAULT 0,
  not_scheduled      integer NOT NULL DEFAULT 0,
  chunks_committed   integer NOT NULL DEFAULT 0,
  completed_at       timestamptz,
  PRIMARY KEY (plan_run_id, branch_id)
);

-- ---------------------------------------------------------------------------------------------
-- Send dispatch state, claims, and late-suppression audit
-- ---------------------------------------------------------------------------------------------
ALTER TABLE sends
  ADD COLUMN dispatch_state        text        NOT NULL DEFAULT 'waiting',
  ADD COLUMN dispatch_generation   integer     NOT NULL DEFAULT 0,
  ADD COLUMN claim_token           uuid,
  ADD COLUMN claimed_by            text,
  ADD COLUMN claim_expires_at      timestamptz,
  ADD COLUMN attempt_count         integer     NOT NULL DEFAULT 0,
  ADD COLUMN first_attempt_at      timestamptz,
  ADD COLUMN provider_message_id   text,
  ADD COLUMN suppression_reason    text,
  ADD COLUMN missed_scheduled_at   timestamptz,
  ADD COLUMN plan_run_id           bigint REFERENCES campaign_plan_runs (id),
  ADD CONSTRAINT sends_dispatch_state_check CHECK (dispatch_state IN (
    'waiting', 'queued', 'claimed', 'retry_wait', 'suppressed', 'complete', 'dead_letter'
  )),
  -- A claim is all-or-nothing, and exists exactly while the send is claimed: one active claim.
  ADD CONSTRAINT sends_claim_shape CHECK (
    (claim_token IS NULL) = (claim_expires_at IS NULL) AND (claim_token IS NULL) = (claimed_by IS NULL)
  ),
  ADD CONSTRAINT sends_claim_matches_state CHECK ((dispatch_state = 'claimed') = (claim_token IS NOT NULL)),
  ADD CONSTRAINT sends_suppression_reason_check CHECK (
    suppression_reason IS NULL OR suppression_reason IN ('opted_out_after_plan', 'missed_slot', 'campaign_cancelled')
  );

-- Existing rows: everything that is not still waiting to go out is already settled.
UPDATE sends SET dispatch_state = CASE status
    WHEN 'planned' THEN 'waiting'
    WHEN 'skipped_opt_out' THEN 'suppressed'
    ELSE 'complete' END;

-- not_scheduled has no slot; skipped_opt_out may keep its slot as an audit trail when a member
-- opts out after planning; every other status has one. Same name as the demo constraint, looser rule.
ALTER TABLE sends DROP CONSTRAINT sends_schedule_matches_status;
ALTER TABLE sends ADD CONSTRAINT sends_schedule_matches_status CHECK (
  CASE status
    WHEN 'not_scheduled' THEN scheduled_at IS NULL
    WHEN 'skipped_opt_out' THEN true
    ELSE scheduled_at IS NOT NULL
  END
);

-- Transition rules, extended for production suppression:
--   planned -> sent | delivered | undelivered | failed          (provider)
--   sent    -> delivered | undelivered | failed                 (provider)
--   planned -> skipped_opt_out   keeps scheduled_at              (consent withdrawn after planning)
--   planned -> not_scheduled     clears scheduled_at, keeps it in missed_scheduled_at (missed slot)
-- Final and suppressed statuses stay terminal. Same-status updates (e.g. dispatch bookkeeping)
-- never bump status_version.
CREATE OR REPLACE FUNCTION sends_guard_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  missed boolean := OLD.status = 'planned' AND NEW.status = 'not_scheduled';
BEGIN
  IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR (NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at AND NOT (missed AND NEW.scheduled_at IS NULL)) THEN
    RAISE EXCEPTION 'send % plan fields are immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = OLD.status THEN
    NEW.status_version := OLD.status_version;
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;

  IF (OLD.status = 'planned' AND NEW.status IN ('sent', 'delivered', 'undelivered', 'failed', 'skipped_opt_out'))
     OR (OLD.status = 'sent' AND NEW.status IN ('delivered', 'undelivered', 'failed'))
     OR missed THEN
    IF missed THEN
      NEW.missed_scheduled_at := OLD.scheduled_at;
    END IF;
    NEW.status_version := OLD.status_version + 1;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'illegal send status transition % -> % for send %', OLD.status, NEW.status, OLD.id
    USING ERRCODE = 'check_violation';
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Append-only send attempts
-- ---------------------------------------------------------------------------------------------
CREATE TABLE send_attempts (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  send_id              integer     NOT NULL REFERENCES sends (id),
  attempt_number       integer     NOT NULL CHECK (attempt_number > 0),
  dispatch_generation  integer     NOT NULL,
  worker_id            text        NOT NULL,
  lease_token          uuid        NOT NULL,
  job_id               text,
  idempotency_key      text        NOT NULL,
  outcome              text        NOT NULL DEFAULT 'in_progress' CHECK (outcome IN (
    'in_progress', 'accepted', 'retryable_error', 'rate_limited', 'permanent_error', 'ambiguous',
    'suppressed', 'lease_lost', 'abandoned'
  )),
  provider_message_id  text,
  provider_request_id  text,
  error_code           text,
  error_message        text,
  started_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at          timestamptz,
  retain_until         timestamptz NOT NULL DEFAULT now() + interval '400 days',
  UNIQUE (send_id, attempt_number),
  CHECK ((outcome = 'in_progress') = (finished_at IS NULL))
);

-- Rows are inserted as in_progress and finished exactly once; history is never rewritten.
-- Deletes are only allowed from the retention/archive procedure (SET LOCAL app.retention = 'on').
CREATE FUNCTION send_attempts_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.retention', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'send_attempts is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.outcome <> 'in_progress'
     OR NEW.id <> OLD.id OR NEW.send_id <> OLD.send_id OR NEW.attempt_number <> OLD.attempt_number
     OR NEW.lease_token <> OLD.lease_token OR NEW.started_at <> OLD.started_at
     OR NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'send attempt % is immutable once finished', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER send_attempts_append_only
  BEFORE UPDATE OR DELETE ON send_attempts
  FOR EACH ROW EXECUTE FUNCTION send_attempts_append_only();

CREATE TABLE send_attempts_archive (LIKE send_attempts INCLUDING DEFAULTS);
ALTER TABLE send_attempts_archive ADD COLUMN archived_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE send_attempts_archive ADD PRIMARY KEY (id);

-- ---------------------------------------------------------------------------------------------
-- Transactional outboxes
-- ---------------------------------------------------------------------------------------------
-- Due-send dispatch: written with the send's state change, relayed to BullMQ by a leased relay.
CREATE TABLE send_outbox (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  send_id              integer     NOT NULL REFERENCES sends (id),
  event_type           text        NOT NULL CHECK (event_type IN ('dispatch')),
  dispatch_generation  integer     NOT NULL CHECK (dispatch_generation > 0),
  job_id               text        NOT NULL,
  payload              jsonb       NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  available_at         timestamptz NOT NULL DEFAULT now(),
  lease_token          uuid,
  lease_expires_at     timestamptz,
  publish_attempts     integer     NOT NULL DEFAULT 0,
  last_error           text,
  published_at         timestamptz,
  retain_until         timestamptz NOT NULL DEFAULT now() + interval '30 days',
  -- An operator retry or a reconciliation repair creates a new generation, never a duplicate.
  CONSTRAINT send_outbox_generation_key UNIQUE (send_id, event_type, dispatch_generation),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

-- Committed send status changes, fanned out to dashboards (Redis Pub/Sub or in-process SSE) by a
-- relay. One row per (send, status_version), so replays and duplicate relays are idempotent.
CREATE TABLE status_event_outbox (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id      integer     NOT NULL,
  send_id          integer     NOT NULL REFERENCES sends (id),
  branch_id        integer     NOT NULL,
  status           text        NOT NULL,
  status_version   integer     NOT NULL,
  payload          jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  lease_token      uuid,
  lease_expires_at timestamptz,
  published_at     timestamptz,
  CONSTRAINT status_event_outbox_version_key UNIQUE (send_id, status_version),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE FUNCTION notify_status_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('status_event_outbox', '');
  RETURN NULL;
END;
$$;

-- Statement-level: one wake-up per committed batch, not per row.
CREATE TRIGGER status_event_outbox_notify
  AFTER INSERT ON status_event_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION notify_status_outbox();

-- ---------------------------------------------------------------------------------------------
-- Provider webhooks: time-partitioned raw receipts + global, non-partitioned dedupe ledger
-- ---------------------------------------------------------------------------------------------
CREATE TABLE provider_event_receipts (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  received_at     timestamptz NOT NULL DEFAULT now(),
  raw_body        bytea       NOT NULL,
  content_type    text,
  -- 'valid' | 'invalid' | 'unsigned' (verification disabled, e.g. local demo)
  auth_status     text        NOT NULL CHECK (auth_status IN ('valid', 'invalid', 'unsigned')),
  signature_key_id text,
  source_ip       inet,
  retain_until    timestamptz NOT NULL DEFAULT now() + interval '90 days',
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

-- Catch-all so a missing future partition never loses a receipt (retention can still sweep it).
CREATE TABLE provider_event_receipts_default PARTITION OF provider_event_receipts DEFAULT;
CREATE INDEX provider_event_receipts_received_at_idx ON provider_event_receipts (received_at);

CREATE FUNCTION ensure_provider_receipt_partitions(p_from date, p_months integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  created integer := 0;
  m date := date_trunc('month', p_from)::date;
  name text;
BEGIN
  FOR i IN 0 .. p_months - 1 LOOP
    name := format('provider_event_receipts_%s', to_char(m, 'YYYY_MM'));
    IF to_regclass(name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF provider_event_receipts FOR VALUES FROM (%L) TO (%L)',
        name, m, (m + interval '1 month')::date);
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END;
$$;

SELECT ensure_provider_receipt_partitions(date_trunc('month', now() - interval '1 month')::date, 4);

CREATE TABLE provider_event_applications (
  event_id             text        PRIMARY KEY,
  receipt_id           bigint      NOT NULL,
  receipt_received_at  timestamptz NOT NULL,
  send_id              integer     NOT NULL,
  status               text        NOT NULL CHECK (status IN ('sent', 'delivered', 'undelivered', 'failed')),
  occurred_at          timestamptz NOT NULL,
  payload_sha256       bytea       NOT NULL,
  disposition          text        NOT NULL CHECK (disposition IN ('applied', 'ignored')),
  reason               text        CHECK (reason IN ('stale', 'unknown_send')),
  processed_at         timestamptz NOT NULL DEFAULT now(),
  -- Dedupe keys must outlive the provider's maximum retry window; see purge_provider_event_applications.
  retain_until         timestamptz NOT NULL DEFAULT now() + interval '400 days',
  CHECK ((disposition = 'applied') = (reason IS NULL))
);

-- Backfill from the demo tables so dedupe and audit history survive the switch.
INSERT INTO provider_event_receipts (id, received_at, raw_body, content_type, auth_status)
  OVERRIDING SYSTEM VALUE
  SELECT id, received_at, raw_body, content_type, 'unsigned' FROM webhook_receipts;
SELECT setval(pg_get_serial_sequence('provider_event_receipts', 'id'),
              GREATEST((SELECT COALESCE(max(id), 0) FROM webhook_receipts), 1),
              (SELECT count(*) > 0 FROM webhook_receipts));

INSERT INTO provider_event_applications
  (event_id, receipt_id, receipt_received_at, send_id, status, occurred_at, payload_sha256, disposition, reason, processed_at)
  SELECT e.event_id, e.receipt_id, r.received_at, e.send_id, e.status, e.occurred_at,
         sha256(r.raw_body), e.disposition, e.reason, e.processed_at
    FROM provider_events e JOIN webhook_receipts r ON r.id = e.receipt_id;

-- ---------------------------------------------------------------------------------------------
-- Retention / archive procedures
-- ---------------------------------------------------------------------------------------------
-- Drops whole monthly receipt partitions that ended before p_before, and sweeps the default
-- partition. Receipts are audit data only; dedupe lives in provider_event_applications.
CREATE FUNCTION drop_expired_provider_receipts(p_before timestamptz) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  part record;
  dropped integer := 0;
BEGIN
  FOR part IN
    SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'provider_event_receipts'::regclass
       AND c.relname ~ '^provider_event_receipts_\d{4}_\d{2}$'
  LOOP
    IF (regexp_match(part.bound, 'TO \(''([^'']+)''\)'))[1]::timestamptz <= p_before THEN
      EXECUTE format('DROP TABLE %I', part.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  DELETE FROM provider_event_receipts_default WHERE received_at < p_before;
  RETURN dropped;
END;
$$;

-- Moves finished attempts older than p_before into the archive table.
CREATE FUNCTION archive_send_attempts(p_before timestamptz) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  moved integer;
BEGIN
  PERFORM set_config('app.retention', 'on', true);
  WITH gone AS (
    DELETE FROM send_attempts WHERE finished_at IS NOT NULL AND finished_at < p_before RETURNING *
  )
  INSERT INTO send_attempts_archive SELECT gone.*, now() FROM gone;
  GET DIAGNOSTICS moved = ROW_COUNT;
  PERFORM set_config('app.retention', 'off', true);
  RETURN moved;
END;
$$;

-- Deletes dedupe keys processed before p_before, but refuses to cut inside the provider's
-- maximum retry window: a late retry of a purged eventId would otherwise be applied again.
CREATE FUNCTION purge_provider_event_applications(p_before timestamptz, p_min_dedupe_window interval)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  removed integer;
BEGIN
  IF p_before > now() - p_min_dedupe_window THEN
    RAISE EXCEPTION 'refusing to purge dedupe keys newer than % (provider retry window %)',
      now() - p_min_dedupe_window, p_min_dedupe_window USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM provider_event_applications WHERE processed_at < p_before;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
