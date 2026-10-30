# Gym SMS production runbook

PostgreSQL is the source of truth for schedules, send state, attempts, webhook receipts, and both
outboxes. Redis (BullMQ jobs, Pub/Sub fan-out) is recoverable transport: losing it delays work
but never loses or duplicates it. Admin endpoints below are on the internal network only and need
`Authorization: Bearer $ADMIN_API_TOKEN`; examples assume `API=https://api.internal`.

## Quick reference

| Symptom / alert | Section |
| --- | --- |
| `DueSendLagHigh`, `MissedSlots`, `QueueOldestJobOld` | [Queue backlog](#queue-backlog) |
| `ProviderErrorRate`, `ProviderRateLimited`, `AmbiguousSends` | [Provider outage or rate limiting](#provider-outage) |
| `DeadLetters` | [Dead letters](#dead-letters) |
| `OutboxBacklog`, `RedisEvictingKeys`, Redis restarted empty | [Redis data loss](#redis-data-loss) |
| `WebhookErrors`, API 503s, DB failover event | [PostgreSQL failover](#postgresql-failover) |
| `WebhooksStopped`, `WebhookInvalidSignatures` | [Webhook outage](#webhook-outage) |
| Member asks to stop / legal hold | [Consent suppression](#consent-suppression) |
| Wrong content / need to stop a campaign | [Campaign pause and recovery](#campaign-pause-and-recovery) |

Useful queries (read replica is fine):

```sql
-- Where is every send of a campaign?
SELECT status, dispatch_state, count(*) FROM sends WHERE campaign_id = $1 GROUP BY 1, 2 ORDER BY 1, 2;
-- Oldest due send still waiting (dispatch lag)
SELECT min(scheduled_at), now() - min(scheduled_at) AS lag FROM sends
 WHERE status = 'planned' AND dispatch_state = 'waiting' AND scheduled_at <= now();
-- One send's full history
SELECT * FROM send_attempts WHERE send_id = $1 ORDER BY attempt_number;
SELECT * FROM provider_event_applications WHERE send_id = $1 ORDER BY processed_at;
```

## Queue backlog

Sends must leave inside their branch's local window and within `MISSED_SLOT_GRACE_MS` (10 min) of
their slot; otherwise the dispatcher or worker marks them `not_scheduled` with
`suppression_reason = 'missed_slot'` (the original slot is kept in `missed_scheduled_at`). Nothing
is ever sent late or out of window, so a backlog costs reach, not compliance.

1. Find the stage that is behind:
   - `gym_due_send_lag_seconds` high and `gym_outbox_oldest_pending_seconds{outbox="dispatch"}` low
     → dispatcher. Check its logs/readiness; scale `dispatcher` (SKIP LOCKED makes replicas safe)
     or shard with `DISPATCH_SHARD_COUNT/INDEX`.
   - outbox age high → relay or Redis; see [Redis data loss](#redis-data-loss).
   - `gym_queue_jobs{state="waiting"}` high → workers. Scale `sms-worker`, but throughput is capped
     by `PROVIDER_RATE_LIMIT_PER_SECOND`; if that is the limit, it's a provider quota question.
2. Missed slots are final for this campaign revision. Report them from
   `SELECT branch_id, count(*) FROM sends WHERE suppression_reason = 'missed_slot' GROUP BY 1`.

## Provider outage

- **5xx / timeouts (retryable)**: BullMQ retries each job with exponential backoff + jitter
  (8 attempts). The same idempotency key `campaign-send:<sendId>` is used every time.
- **429**: the worker pauses the whole provider queue for `Retry-After` without consuming
  attempts. Persistent 429s mean the configured rate exceeds the account quota: lower
  `PROVIDER_RATE_LIMIT_PER_SECOND` (ConfigMap) and roll the workers.
- **Ambiguous** (timeout after the request was sent): retried with the same key inside
  `PROVIDER_IDEMPOTENCY_WINDOW_MS`. After that window the send is parked in `dead_letter`, still
  `planned`, because it may have been delivered.
- **Full outage**: pause dispatch so slots are not burned into retries, then resume:
  `curl -XPOST -H "Authorization: Bearer $T" $API/v1/admin/campaigns/$ID/dispatch/pause`
  (or `POST $API/v1/admin/queue/pause` to stop all workers taking jobs; in-flight calls finish).
  Sends whose slots pass during the pause become `missed_slot`.
- Liveness probes never depend on the provider; don't restart pods for a provider outage.

## Twilio specifics

- **No idempotency key.** Twilio's Messages API can't dedupe a retried create. When the outcome
  is ambiguous (timeout, a 502 without a Twilio error body), the worker does **not** retry. It
  lists recent messages to that number (`GET /Messages.json?To=…`) and matches the exact body
  created since the attempt started. A match records the send as `sent` with that `SM…` sid. No
  match parks it in `dead_letter` (still `planned`). Before retrying a parked send, check the
  Twilio console or Message logs for the number: if a message exists, don't retry.
- **STOP replies.** Twilio error 21610 (recipient unsubscribed) fails that send and sets
  `members.sms_opt_out = true`, so the member's other planned sends are suppressed at claim.
- **Status callbacks** go to `/v1/webhooks/twilio?sendId=…`, signed with the account auth token.
  The URL Twilio signs must equal `TWILIO_WEBHOOK_PUBLIC_BASE_URL` + path; a proxy that rewrites
  the host or scheme causes `WebhookInvalidSignatures`.
- **Auth token rotation:** create the secondary token in Twilio, set `gym-sms/twilio-auth-tokens`
  to `primary,secondary`, reload (SIGHUP or restart), promote the secondary in Twilio, then
  remove the old token from the secret. API key secrets used for sending
  (`twilio-api-key-secret`) rotate independently: create a new key, update the secret, restart
  workers, delete the old key.
- **Missing callbacks.** Twilio doesn't guarantee delivery of status callbacks, so a send can
  stay `sent` without a final status. Query `SELECT id, provider_message_id FROM sends WHERE
  status = 'sent' AND updated_at < now() - interval '24 hours'` and check those sids in Twilio.
  An automated status poller is a planned follow-up (see the capacity report).
- **Throughput:** `PROVIDER_RATE_LIMIT_PER_SECOND` must not exceed the Messaging Service's MPS.
  Twilio 429/20429 responses pause the whole queue for `Retry-After`.

## Dead letters

`dead_letter` = automatic retries exhausted. `GET $API/v1/admin/campaigns/$ID/dead-letters` lists
them with the last error; `GET $API/v1/admin/sends/$SEND/attempts` shows the history.

- Status `failed`: permanent failure after retries; nothing to do unless the cause was ours.
- Status `planned` (ambiguous): ask the provider whether the idempotency key / message was
  accepted. If it **was**, leave it (the delivery webhook will arrive or has been lost). If it
  **was not**, and the slot is still within its window, retry:
  `POST $API/v1/admin/sends/$SEND/retry` (new dispatch generation, same idempotency key).
  Never retry an ambiguous send without checking: that's how a member gets two messages.

## Redis data loss

Redis holds only queued jobs and transient Pub/Sub. PostgreSQL knows every send in flight.

1. Confirm `noeviction` and persistence: `redis-cli CONFIG GET maxmemory-policy` must be
   `noeviction`; `gym_redis_evicted_keys` must be 0.
2. After Redis returns (empty or partial):
   - unpublished dispatch outbox rows are relayed automatically when Redis accepts writes;
   - the dispatcher's reconciler (every 30s) finds `queued`/`retry_wait`/expired-`claimed` sends
     whose job is missing and re-dispatches them under a new generation;
   - to force it immediately after a known loss: `POST $API/v1/admin/outbox/replay
     {"since": "<time Redis was lost>"}` (job ids are deterministic, so existing jobs dedupe and
     the worker's database claim stops any duplicate provider call).
3. Dashboards reconnect and reload a snapshot from PostgreSQL; no status is lost.

## PostgreSQL failover

Managed failover typically takes 30–120s. During it:
- the webhook returns 503 (receipt could not be stored) and the provider retries;
- workers fail claims and BullMQ retries the jobs;
- readiness probes fail, so pods leave load balancing but are not restarted.

Afterwards: check `gym_webhook_requests_total{result="error"}` returns to 0, `OutboxBacklog`
clears, and run `POST $API/v1/admin/campaigns/$ID/status-counts/reconcile` (expected: empty drift).

## Webhook outage

- `WebhooksStopped`: sends are accepted but no callbacks arrive. Check the provider's webhook
  console/URL, the `webhooks` ingress, WAF allow-list, and certificate. Sends stay `sent`; once
  callbacks resume (providers retry), states catch up. Raw bodies are in
  `provider_event_receipts` for audit.
- `WebhookInvalidSignatures`: usually a secret rotation mismatch.
  **Rotation procedure**: (1) add the new secret first: set
  `gym-sms/webhook-signing-secrets` to `new,old`; ESO syncs it; `kubectl -n gym-sms rollout restart
  deploy/api` (or send SIGHUP to reload without restart). (2) Switch the provider to the new
  secret. (3) After the provider's retry window, set the secret to `new` only and reload.
  `provider_event_receipts.signature_key_id` shows which key each request used.
- Invalid-signature receipts are stored (7-day retention) but never processed.

## Consent suppression

Workers re-read `members.sms_opt_out` immediately before every provider call. To stop a member:
`UPDATE members SET sms_opt_out = true WHERE id = $1;` Any not-yet-sent send becomes
`skipped_opt_out` (slot kept for audit, `suppression_reason = 'opted_out_after_plan'`). Sends
already accepted by the provider can't be recalled.

## Campaign pause and recovery

- Pause: `POST $API/v1/admin/campaigns/$ID/dispatch/pause`. The dispatcher stops queuing; workers
  hand already-queued sends back to `waiting` instead of sending.
- Resume: `POST $API/v1/admin/campaigns/$ID/dispatch/resume`. Slots that passed while paused
  become `missed_slot`.
- Cancel (no resume): `POST $API/v1/admin/campaigns/$ID/cancel`. In one transaction every send not
  yet handed to the provider becomes `not_scheduled` (`suppression_reason = 'campaign_cancelled'`)
  and dashboards are notified; a send mid-provider-call finishes, queued jobs then skip.
- Different audience or content: create a new campaign revision. Audience snapshots and plans are
  immutable by design.

## Deploys and migrations

- Migrations run in the pre-sync `gym-sms-migrate` Job with the owner role; app pods run with
  `RUN_MIGRATIONS=false`. Migrations are expand-only (new tables/columns, looser constraints), so
  old and new pods run side by side. Destructive "contract" changes (e.g. dropping the legacy
  `webhook_receipts`/`provider_events` tables) ship in a later release once no old pod remains.
- `003_delivery_indexes.sql` uses `CREATE INDEX CONCURRENTLY`. If it fails midway, an INVALID
  index can remain: `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`, then
  `DROP INDEX CONCURRENTLY <name>;` and re-run the Job.
- Rollback = deploy the previous image. Schema stays (expand-only); restore from backup only for
  data corruption, never for a code rollback.

## Backup and restore

- Managed PostgreSQL: automated daily backups + PITR (7–35 days per policy).
- Drill (monthly, and before rollout): `scripts/backup-restore-drill.sh` dumps, restores into a
  scratch database, and verifies migrations, row counts, triggers, terminal-status enforcement,
  and counter reconciliation. In staging, run the same checks against a PITR restore of the
  managed instance and record RTO (restore time) and RPO (PITR lag).
- Redis is not backed up for recovery purposes: PostgreSQL + reconciliation rebuilds its state.

## Retention

The dispatcher's maintenance loop (advisory-locked) creates upcoming monthly receipt partitions,
drops receipt partitions older than `RECEIPT_RETENTION_DAYS`, archives attempts older than
`ATTEMPT_ARCHIVE_DAYS`, and purges dedupe keys older than `DEDUPE_RETENTION_DAYS`, refusing to
purge inside `PROVIDER_RETRY_WINDOW_DAYS` (a late retry of a purged event id would apply twice).
