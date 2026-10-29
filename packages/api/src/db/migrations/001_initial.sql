-- Gym SMS campaign schema. PostgreSQL is the source of truth: uniqueness, plan
-- idempotence, and monotonic send status are enforced here, not only in app code.

CREATE TABLE branches (
  id         integer PRIMARY KEY,
  name       text    NOT NULL UNIQUE,
  time_zone  text    NOT NULL
);

CREATE TABLE members (
  id           integer PRIMARY KEY,
  branch_id    integer NOT NULL REFERENCES branches (id),
  name         text    NOT NULL,
  phone        text    NOT NULL UNIQUE,
  sms_opt_out  boolean NOT NULL DEFAULT false,
  -- Lets sends reference (member, branch) so a send can never disagree with its member's branch.
  UNIQUE (id, branch_id)
);
CREATE INDEX members_branch_id_idx ON members (branch_id, id);

CREATE TABLE campaigns (
  id          integer PRIMARY KEY,
  name        text        NOT NULL,
  start_date  date        NOT NULL,
  end_date    date        NOT NULL,
  -- NULL until the first complete plan commits; set in the same transaction as the send rows.
  planned_at  timestamptz,
  CHECK (end_date >= start_date)
);

CREATE TABLE campaign_branches (
  campaign_id  integer NOT NULL REFERENCES campaigns (id),
  branch_id    integer NOT NULL REFERENCES branches (id),
  PRIMARY KEY (campaign_id, branch_id)
);

CREATE TABLE sends (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id     integer     NOT NULL,
  branch_id       integer     NOT NULL,
  member_id       integer     NOT NULL,
  status          text        NOT NULL,
  scheduled_at    timestamptz,
  status_version  integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sends_status_check CHECK (status IN (
    'planned', 'sent', 'delivered', 'undelivered', 'failed', 'skipped_opt_out', 'not_scheduled'
  )),
  CONSTRAINT sends_schedule_matches_status CHECK (
    (scheduled_at IS NULL) = (status IN ('skipped_opt_out', 'not_scheduled'))
  ),
  CONSTRAINT sends_member_branch_fk FOREIGN KEY (member_id, branch_id) REFERENCES members (id, branch_id),
  CONSTRAINT sends_campaign_branch_fk FOREIGN KEY (campaign_id, branch_id)
    REFERENCES campaign_branches (campaign_id, branch_id),
  CONSTRAINT sends_campaign_member_key UNIQUE (campaign_id, member_id)
);

-- One member per branch-local slot. Final guard behind the planner's own slot assignment.
CREATE UNIQUE INDEX sends_campaign_branch_slot_key
  ON sends (campaign_id, branch_id, scheduled_at)
  WHERE scheduled_at IS NOT NULL;

CREATE INDEX sends_campaign_id_idx            ON sends (campaign_id, id);
CREATE INDEX sends_campaign_status_idx        ON sends (campaign_id, status, id);
CREATE INDEX sends_campaign_branch_status_idx ON sends (campaign_id, branch_id, status, id);
CREATE INDEX sends_campaign_scheduled_idx     ON sends (campaign_id, scheduled_at) WHERE scheduled_at IS NOT NULL;

-- Backstop for the webhook's conditional UPDATE: also rejects illegal changes made via direct SQL.
--   planned -> sent | delivered | undelivered | failed
--   sent    -> delivered | undelivered | failed
--   delivered, undelivered, failed, skipped_opt_out, not_scheduled are terminal.
-- Same-status updates are accepted as no-ops and do not bump status_version.
CREATE FUNCTION sends_guard_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at THEN
    RAISE EXCEPTION 'send % plan fields are immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = OLD.status THEN
    NEW.status_version := OLD.status_version;
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;

  IF (OLD.status = 'planned' AND NEW.status IN ('sent', 'delivered', 'undelivered', 'failed'))
     OR (OLD.status = 'sent' AND NEW.status IN ('delivered', 'undelivered', 'failed')) THEN
    NEW.status_version := OLD.status_version + 1;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'illegal send status transition % -> % for send %', OLD.status, NEW.status, OLD.id
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER sends_guard_transition
  BEFORE UPDATE ON sends
  FOR EACH ROW EXECUTE FUNCTION sends_guard_transition();

-- Every webhook HTTP request body, byte for byte, committed before parsing/validation.
-- Includes malformed requests and repeats of an already-processed eventId.
CREATE TABLE webhook_receipts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  raw_body      bytea       NOT NULL,
  content_type  text,
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_receipts_received_at_idx ON webhook_receipts (received_at);

-- One row per distinct valid provider eventId: the at-most-once processing ledger.
-- No FK to sends, so a well-formed event for an unknown send can still be recorded and acknowledged.
CREATE TABLE provider_events (
  event_id      text        PRIMARY KEY,
  receipt_id    bigint      NOT NULL REFERENCES webhook_receipts (id),
  send_id       integer     NOT NULL,
  status        text        NOT NULL CHECK (status IN ('sent', 'delivered', 'undelivered', 'failed')),
  occurred_at   timestamptz NOT NULL,
  disposition   text        NOT NULL CHECK (disposition IN ('applied', 'ignored')),
  reason        text        CHECK (reason IN ('stale', 'unknown_send')),
  processed_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((disposition = 'applied') = (reason IS NULL))
);
CREATE INDEX provider_events_send_id_idx ON provider_events (send_id);
