# Notes

## Core decisions
- **PostgreSQL is the source of truth for correctness.** Unique `(campaign, member)` and partial unique `(campaign, branch, scheduled_at)` keys, a branch-consistent composite FK, and a trigger that enforces `planned → sent → final` (final statuses terminal, plan fields immutable) back up the application rules.
- **Planning** builds slots from local calendar dates (Mon–Sat, 09:00–19:58, every 2 min), so London's 25 Oct DST change moves the UTC offset, not the local times. The first plan freezes an **immutable audience snapshot**. The plan comes from that snapshot and nothing else: changed membership needs a new campaign revision, or `npm run reset` in the demo. The historical demo campaign is still planned exactly as configured. Live campaigns never get past slots.
- **Webhooks**: the request bytes are committed (`bytea`) before parsing. A second transaction claims the `eventId` in a global dedupe ledger, runs a conditional `UPDATE` re-checked under the row lock (the first committed final status wins regardless of `occurredAt`), and writes a status-outbox row. Fan-out happens only after commit. `200`: applied, duplicate, stale, or unknown send. `400`: malformed. `401`: bad or stale HMAC signature. `429`: rate limited. `503`: transient failure, so the provider retries.
- **Live UI**: the client opens SSE, waits for `ready`, then loads the snapshot and merges by `statusVersion`, so a slow page never regresses a row. Updates are flushed once per animation frame into a virtualized table. Every reconnect reloads from PostgreSQL. Campaigns above 20k sends switch to server-filtered windows with counts from the projection.
- **Versioning**: `/v1/...` in the path. The spec's unprefixed paths are an alias pinned to v1, so existing clients and provider webhook URLs never break.

## Production delivery (100 branches / 5M members)
- **Capacity is a product decision first.** 1,980 weekly slots per branch leaves about 96% of 50k members `not_scheduled`. `GET /capacity` shows this before planning, and rollout is gated on product sign-off.
- **Planning** is a resumable run: it streams the snapshot per branch in member order, `COPY`s each chunk into staging, and merges it in the same transaction as the branch checkpoint. A crash resumes exactly where it stopped. A session advisory lock allows one executor. Measured results are in `docs/production-capacity-report.md`.
- **Dispatch**: the dispatcher claims due rows with `FOR UPDATE SKIP LOCKED`, marks them `queued` with a new dispatch generation, and writes a transactional outbox row. The leased relay enqueues each one into BullMQ with a deterministic job id only after commit. A reconciler re-dispatches anything PostgreSQL says is in flight but Redis lost. Redis is transport, never the record.
- **Workers** treat BullMQ as at-least-once. A PostgreSQL claim (lease token, generation match, no live claim) is the correctness boundary. Consent, pause/cancel, and the local window (plus a 10-minute missed-slot grace) are rechecked right before the provider call. Nothing is sent early, late, or outside the window: missed slots become `not_scheduled` and alert. 429s back off the whole provider queue. Retries use the stable key `campaign-send:<sendId>`. A final webhook that beats the worker is never overwritten.
- **Fan-out**: status changes reach every API replica through the status outbox and Redis Pub/Sub. Counters are a transactional statement-level projection with periodic reconciliation.
- **Operations**: signed webhooks with key rotation, per-pod rate limits, Prometheus metrics with alerts, JSON logs with correlation ids and phone redaction, opt-in OpenTelemetry, liveness/readiness split, admin controls, partitioned receipts with retention, and Kubernetes manifests.

## Exactly-once sending: what is and isn't guaranteed
The claims guarantee that no two workers call the provider for the same send at the same time. A crash after the provider accepted but before the commit is retried with the **same idempotency key**. If the provider honours that key for `PROVIDER_IDEMPOTENCY_WINDOW_MS`, that is exactly-once acceptance. An ambiguous send older than the window is parked in `dead_letter` (still `planned`) for manual reconciliation rather than resent. Without provider-side idempotency the honest guarantee is "at least once, never concurrently".

## Still open (needs decisions, not code)
- The SMS vendor: the generic HTTPS adapter and a mock provider stand in, and its signature scheme, quotas, and key-retention window are still unknown.
- The cloud target: the manifests are generic Kubernetes and haven't been applied to a cluster.
- The approved missed-slot policy (implemented: mark `not_scheduled` and alert).
- Retention and legal periods, and a staging restore drill against the managed database.
