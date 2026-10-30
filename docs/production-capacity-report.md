# Production capacity report

Status: **planning and dispatch measured locally; vendor and staging items open.** Product
decisions on capacity and missed slots are recorded. The SMS vendor is Twilio. Go/no-go gates
are at the end.

| | |
| --- | --- |
| Measured | planning 2026-10-29 (commit `af639a3`); dispatch 2026-10-30 (with the attempt-limit fix below) |
| Environment | Docker Desktop on one Mac (Apple Silicon); PostgreSQL 16 (`shm_size` 512 MB), Redis 7 (`noeviction`, AOF); planner running on the host |
| Not representative of | managed PostgreSQL/Redis IOPS, network latency, or multi-node contention. Treat absolute timings as a lower bound to re-measure in staging |

## 1. Bulk planning: 100 branches, 5,000,000 members

`npm run load:plan -- --members 5000000 --branches 100 --chunk 50000 --crash-at 37`
(`packages/api/test/load/plan-5m-members.ts`). The run used 100 branches spread over 10 IANA zones
(London, Kathmandu, Sydney, New York, Los Angeles, Tokyo, Berlin, Kolkata, São Paulo, and
Johannesburg), 50,000 members per branch, and a 5% opt-out spread evenly through each branch's id
range. The campaign covered 2026-10-23 to 2026-10-29: six send days, 1,980 slots per branch.

### Time and memory

| Metric | Result |
| --- | --- |
| Seed 5M members (`generate_series`) + `VACUUM ANALYZE` | 45.3 s |
| Audience snapshot + planning until the forced crash at chunk 37 | 175.6 s (1,800,000 sends committed) |
| Resume from checkpoints to completion | 115.5 s |
| **Total planning** | **291.1 s** (≈17,200 rows/s end to end) |
| Plan run attempts | 2 (crash + resume), status `completed` |
| Planner peak RSS / heap | **154 MB / 113 MB**, bounded by the 50k chunk size and independent of audience size |

### Correctness at scale

| Check | Result |
| --- | --- |
| Sends = members | 5,000,000 = 5,000,000 (one per member, no duplicates) |
| Planned | 198,000 (100 × 1,980) ✅ |
| Opted out (`skipped_opt_out`) | 250,000 ✅ |
| Not scheduled | 4,552,000, which is **95.8% of eligible members** |
| Duplicate `(campaign, branch, slot)` | 0 |
| Slots outside Mon–Sat 09:00–19:58 local | 0 (across all 10 zones, including the London DST change) |
| Slot order vs member id within a branch | 0 violations |
| Counter projection drift (`reconcile_status_counts`) | 0 |
| Resume after crash | no gaps, no duplicates; identical totals to an uninterrupted run |

Crash and resume are also covered on every `npm test` run at small scale, with a crash at the first,
a middle, the last, a later-branch, and the final chunk, plus a crash between chunk commits. Every
case is compared row by row against the pure planner.

### Storage

| Object | Size |
| --- | --- |
| `sends` total | 1,692 MB (heap 599 MB, indexes 1,093 MB) |
| `campaign_audience_members` (snapshot) | 607 MB |
| `members` | 797 MB |
| `campaign_branch_status_counts` | 88 kB |
| Whole database | 3,106 MB |

Largest `sends` indexes:

| Index | Size | Note |
| --- | --- | --- |
| `sends_campaign_branch_status_idx` | 418 MB | covers every row, 91% of them `not_scheduled` |
| `sends_campaign_status_idx` | 336 MB | covers every row |
| `sends_campaign_id_idx` | 108 MB | |
| `sends_pkey` | 107 MB | |
| `sends_campaign_member_key` | 107 MB | uniqueness guard; required |
| `sends_due_idx` (partial) | 7.8 MB | only planned + waiting; this is what the dispatcher uses |
| `sends_campaign_branch_slot_key` (partial) | 6.1 MB | slot uniqueness guard |

### Read latency on the 5M-row campaign (median of 5, warm cache)

| Query | Latency |
| --- | --- |
| `GET /summary` (projection + per-branch first/last slot) | 3.3 ms |
| First page, 1,000 sends | 3.4 ms |
| Deep page (cursor 4,900,000) | 3.1 ms |
| Branch + status filter | 9.1 ms |
| Rare status filter (`skipped_opt_out`) | 4.1 ms |

The summary stays constant-time because counts come from the transactional projection instead of
`GROUP BY` over 5M rows. Keyset pagination doesn't slow down with depth. For campaigns above 20k
sends the dashboard switches to server-filtered windows, so the browser never loads 5M rows.

## 2. End-to-end delivery

### Live pipeline smoke (compose stack, real processes)

Campaign 2 (`npm run demo:live`) had 4 London branches and 92 planned sends, sent through the
dispatcher, outbox relay, BullMQ, 2 workers, the mock provider, and signed webhooks to 2 API
replicas:

- Every send left at its slot second (16:00:00 and 16:02:00 UTC); none were early.
- Two injected provider 503s were retried after backoff (≈2 s) and accepted on attempt 2.
- Delivery callbacks moved sends to `delivered` or `undelivered`. The mock provider recorded 20
  acceptances with 0 idempotent replays, so each send was accepted once.

### Dispatch and worker throughput under load

`npm run load:dispatch -- --branches 2000 --slots 5 --workers 4 --concurrency 25 --rate 400`
(`packages/workers/test/load/dispatch-throughput.ts`), run 2026-10-30 03:26 UTC, in the
Asia/Tokyo window (12:26 local).

**Setup.** 2,000 branches, each with 5 slots already due at start plus 1 slot two minutes later:
12,000 sends in total, of which 10,000 were a deliberate backlog and 2,000 became due
mid-run. The real dispatcher, outbox relay, BullMQ (compose Redis), and 4 workers × 25
concurrency ran with the production retry policy (8 attempts, exponential backoff with jitter)
and a queue-wide limit of 400 sends/s. The provider honoured idempotency keys and injected
20–80 ms latency, 8% 503s, 1% 429s (Retry-After 300 ms), and 1% accepted-then-timeout. One worker
was force-killed (no graceful close) a third of the way in, while it held **100 active jobs**.

| Metric | Result |
| --- | --- |
| Sends completed | **12,000 / 12,000** `sent`; 0 failed, 0 missed, 0 dead-lettered |
| Provider calls / acceptances | 13,369 calls → **12,000 acceptances, exactly one per send** (12,000 sends carry a provider message id) |
| Attempts by outcome | accepted 12,000 · retryable 1,119 · rate-limited 123 · ambiguous 127 |
| Sent before its slot | **0** |
| Backlog drain (10,000 due at start) | 59.3 s → **≈169 sends/s** sustained through faults and the killed worker |
| On-time sends (slot arrived mid-run): slot → first attempt | p50 **4.3 s**, p95 **7.9 s**, max 8.4 s |
| On-time sends: slot → provider acceptance | p95 8.7 s (missed-slot grace is 600 s) |
| Killed worker's 100 in-flight jobs | all recovered (stalled → re-claimed after lease expiry), none sent twice |
| Peak queued jobs | 8,990 |
| Redis used memory | 17.7 → 30.6 MB at peak backlog (≈1.4 KB per queued job) |

**Reading the numbers**
- The on-time lag is dominated by the rate limit: 2,000 slots fire in the same second and are
  spread at 400/s (≈5 s). It scales with branches per slot ÷ provider throughput. At 100
  branches, one slot is 100 sends, well under a second at Twilio's MPS.
- The 169/s backlog rate is below the 400/s limit. On this laptop the bottleneck is the claim
  and complete transactions (two short transactions plus a status-outbox row per send, on one
  PostgreSQL). It's ample for the product rule (100 branches × 1 send per 2 min ≈ 0.8 sends/s),
  and only matters for catching up after an outage.
- **Bug found and fixed by this test.** The worker decided "retries exhausted" from its own
  configured maximum instead of the job's attempt limit. A job created without retry options
  failed permanently in BullMQ while PostgreSQL still said `retry_wait`. The processor now uses
  the job's own limit (`job.opts.attempts`), with a regression test. The dispatcher's reconciler
  would also have repaired those sends after `RECONCILE_STALE_MS`.

### Twilio-specific behaviour (functional, against a fake Twilio API)

Twilio was selected as the vendor. Its Messages API has **no idempotency key** (only the Bulk
Messaging API accepts an `IdempotencyToken`), so the generic "retry an ambiguous send with the
same key" path doesn't apply. Implemented and tested:
- **Ambiguous outcome** (timeout, a 5xx without a Twilio error body): no retry. The worker looks
  the message up (recipient, exact body, created since the attempt). A match records `sent` with
  that `SM…` sid; no match parks the send in `dead_letter`, still `planned`, for an operator. A
  test verifies that only one create request is ever made.
- **Proven not created** (connection refused, 429/20429, 5xx with a Twilio error code): retried
  normally; 429 pauses the queue for `Retry-After`.
- **STOP (21610)**: the send fails and the member is marked `sms_opt_out`.
- **Status callbacks** at `/v1/webhooks/twilio?sendId=`: `X-Twilio-Signature` (HMAC-SHA1) is
  verified with primary and secondary auth tokens. Our implementation is checked against Twilio's
  official SDK (`getExpectedTwilioSignature` / `validateRequest`). Tampering with `sendId` fails
  verification. Dedupe key is `MessageSid:MessageStatus`; non-final statuses are acknowledged and
  ignored.

### Webhook ingestion (indicative only)

Before the production changes, the simulator posted 18,423 requests (9,280 logical events, 1–3
copies each) in 9.4 s, about 1,960 requests/s with 50 in flight against one API instance, with no
errors. It hasn't been re-measured since HMAC verification, the receipts table partitioning, and
status-outbox writes were added, so re-measure it with the dispatch test.

## 3. Findings and tuning

1. **Reach, not throughput, is the binding constraint.** At one slot per branch every two
   minutes, a 7-day campaign reaches 1,980 members per branch: 4% of eligible members at 50k per
   branch. Planning 4.55M `not_scheduled` rows costs most of the storage and time. Product
   accepted this outcome on 2026-10-30 (gate G1).
2. **Index bloat from `not_scheduled` rows.** 754 MB of the two status indexes cover rows that
   are never read by status in practice. Recommendation: convert `sends_campaign_status_idx` and
   `sends_campaign_branch_status_idx` to partial indexes excluding `not_scheduled` (keep a small
   partial index for that status if filtering on it is required), built with `CREATE INDEX
   CONCURRENTLY` in an expand migration. Expected saving is roughly 600–700 MB per 5M-member
   campaign, with faster planning writes.
3. **Snapshot cost.** The immutable audience costs 607 MB per 5M-member revision. Add retention
   for snapshots of completed campaigns (archive after the reporting period), and don't create a
   revision per minor edit.
4. **Chunk size.** 50k rows per chunk keeps memory at ~150 MB and each chunk transaction short.
   Raising it mainly raises memory; lowering it adds per-chunk overhead. Keep 50k, and
   re-measure on managed PostgreSQL where commit latency is higher.
5. **Container shared memory.** Parallel `VACUUM`/queries on millions of rows exhausted
   Docker's default 64 MB `/dev/shm`. Compose now sets `shm_size: 512mb`. Managed PostgreSQL is
   unaffected, but any self-hosted PostgreSQL needs the same.
6. **Planning duration vs dispatch.** A 5M plan takes about 5 minutes locally. Live campaigns
   only get slots at or after the run's `earliest_slot_at`, so plan well before the campaign
   starts.

## 4. Go / no-go gates

| Gate | Status |
| --- | --- |
| G1. Capacity outcome (≈96% `not_scheduled` at 50k/branch) | ✅ Approved by product (2026-10-30): keep the one-slot-per-2-minutes rule |
| G2. Missed-slot policy | ✅ Approved (2026-10-30): mark `not_scheduled`, alert, 10-min grace (as built) |
| G3. SMS vendor and idempotency contract | ✅ Twilio selected. ⚠️ **No idempotency key** on the Messages API: mitigated by lookup-then-park (never a blind resend). Residual risk: an ambiguous send that the lookup doesn't find needs an operator decision. Needs explicit risk acceptance |
| G4. Vendor webhook signature | ✅ Twilio `X-Twilio-Signature` implemented, verified against Twilio's SDK, with auth-token rotation |
| G5. Bulk planning at 5M: deterministic, resumable, bounded memory | ✅ Passed (local); re-measure in staging |
| G6. Dispatch/worker throughput, no early or out-of-window sends, one acceptance per send | ✅ Passed locally: 12,000/12,000, 0 early, 0 duplicates, ≈169 sends/s backlog, on-time p95 7.9 s |
| G7. Fault injection: DB, Redis, provider, webhook, process kill under load | ✅ Automated tests + a killed worker under load (100 in-flight jobs recovered) |
| G8. Backup/restore drill | ✅ Local drill passed; ⏸ staging PITR restore deferred (no managed database yet) |
| G9. Cloud target, manifests applied in staging, alerts routed | ⏸ Deferred: no cloud target or credentials yet (the only local kube contexts belong to another environment and were not used) |
| G10. Multi-replica API and SSE fan-out under concurrent viewers | ✅ Functional (2 replicas via Redis Pub/Sub); ⏳ many-viewer load test not done |
| G11. Live Twilio verification | ⏳ The adapter is tested against a fake API only. Needs a Twilio test or sub-account: send to magic/test numbers, receive real status callbacks, confirm MPS |

**Verdict: no-go until** G3's residual risk is formally accepted, G11 is verified against a real
Twilio account, and G8 and G9 run in a staging environment. The architecture and the local
measurements don't block launch.

### Follow-ups recommended before launch
1. **Twilio status poller.** Twilio doesn't guarantee callback delivery, so a send can stay `sent`
   with no final status. Add a periodic job that fetches `GET /Messages/{sid}.json` for sends in
   `sent` longer than N hours and applies the result through the same transition path. The
   runbook has the manual query for now.
2. Partial status indexes (finding 2) to remove ≈700 MB per 5M-member campaign.
3. Re-measure the webhook ingestion rate with signatures and receipt partitioning.
