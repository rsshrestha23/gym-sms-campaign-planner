# Gym SMS campaign

Plans the "Win-back October" SMS campaign for gym branches in each branch's local time, sends due messages through a BullMQ worker pipeline, ingests signed, idempotent delivery webhooks from an SMS provider, and shows live per-branch and per-send status.

- **API**: Node.js, TypeScript, Express, PostgreSQL (`packages/api`)
- **Dispatcher and outbox relay**: due-send dispatch, Redis repair, retention (`packages/dispatcher`)
- **Workers**: BullMQ send workers and provider adapters (`packages/workers`)
- **Web**: React, TypeScript, Vite, SSE, virtualized table (`packages/web`)
- **Tests**: Vitest, Supertest, Testcontainers (PostgreSQL and Redis)
- **Deployment**: platform-neutral Kubernetes manifests (`infra/production`), [runbook](docs/production-runbook.md), and [capacity report](docs/production-capacity-report.md)

## Architecture

```
            plan (resumable, COPY chunks)            webhooks (HMAC-signed)
 dashboard ───────────────► PostgreSQL ◄────────────────────────── SMS provider
    ▲  SSE                  (source of truth)                        ▲
    │                        │       ▲                               │ send (Idempotency-Key)
 API replicas ◄── Redis Pub/Sub ◄── relay ◄─ status outbox           │
                             │       │                               │
                  dispatcher ┘       └─ relay ──► BullMQ (Redis) ──► workers
          (due sends → outbox, SKIP LOCKED)      (jobs, rate limit)  (PostgreSQL claim, consent + window recheck)
```

PostgreSQL holds every schedule, send state, attempt, raw webhook receipt, and both outboxes. Redis is recoverable transport: if jobs are lost, the dispatcher's reconciler re-dispatches them from PostgreSQL. [NOTES.md](NOTES.md) explains the design decisions.

## Run it

```bash
docker compose up --build
```

| What | URL |
| --- | --- |
| Campaign dashboard | http://localhost:8080 (`?campaign=2` for the live smoke campaign) |
| API (direct, replica 1) | http://localhost:3000 |
| Mock SMS provider | http://localhost:4010/stats |
| PostgreSQL | `postgres://gym:gym@localhost:5433/gym` |
| Redis | `redis://localhost:6380` |

The stack runs PostgreSQL, Redis, two API replicas behind nginx, the dispatcher, the outbox relay, two workers, and a mock SMS provider. The mock provider honours idempotency keys, injects 5% 503s and 2% 429s, and posts signed delivery callbacks. Every secret in `docker-compose.yml` is a development value.

On startup the first API replica runs migrations and seeds the demo data before it starts listening, and every other service waits until it's ready. The seed creates three branches, 5,000 members, and campaign 1 ("Win-back October", 2026‑10‑23 → 2026‑10‑29). Restarting is safe: the seed is an idempotent upsert and never touches sends.

### Demo campaign 1 (historical, simulator-driven)

Campaign 1 starts **unplanned** and has dispatch disabled, so the dispatcher never sends it. Click **Plan campaign** on the dashboard, or run:

```bash
curl -X POST http://localhost:3000/v1/campaigns/1/plan                                   # synchronous, 201/200
curl -X POST -H 'Prefer: respond-async' http://localhost:3000/v1/campaigns/1/plan        # 202 { planRunId }
```

Then simulate the provider's callbacks (see below).

### Live campaign 2 (real pipeline)

```bash
docker compose exec api npm run demo:live                 # default --zone Europe/London --branches 4 --members 25
docker compose exec api npm run demo:live -- --zone America/New_York
```

This creates a dispatch-enabled campaign for extra branches in a zone whose sending window is open now, and plans it from the next free slot. Each branch then sends one message every two minutes through dispatcher → outbox → relay → BullMQ → worker → mock provider → signed webhook. Watch it at http://localhost:8080/?campaign=2.

## API

The API is versioned by URL path, and `/v1` is the current version. Timestamps are ISO‑8601 UTC.

- **Canonical paths** start with `/v1`. The dashboard, simulator, and mock provider use them.
- **Unversioned paths** from the original spec (`/campaigns/...`, `/webhooks/provider`) are a permanent alias **pinned to v1**.
- Responses carry `API-Version: v1`. An unknown version such as `/v2/...` returns `404 unsupported_api_version`.

| Method & path (prefix with `/v1`) | Purpose |
| --- | --- |
| `POST /campaigns/:id/plan` | Plan once. Synchronous by default (`201` created / `200` existing, with counts); `Prefer: respond-async` returns `202 { planRunId }` |
| `GET /campaigns/:id/plan-runs/:planRunId` | Plan run progress: status, per-branch checkpoints, processed/expected rows |
| `GET /campaigns/:id/capacity` | Slots vs eligible members per branch, and the projected not-scheduled share |
| `GET /campaigns/:id/summary` | Status counts per branch (from the transactional projection), plus first/last `scheduledAt` |
| `GET /campaigns/:id/sends?branchId=&status=&cursor=&limit=` | Keyset pagination by send id. `limit` defaults to 100, max 1000 |
| `GET /campaigns/:id/events` | SSE: a `ready` frame, then `send.updated` for each committed change (across all replicas) |
| `POST /webhooks/provider` | Provider callback `{ eventId, sendId, status, occurredAt }`, signed with `X-Provider-Timestamp` + `X-Provider-Signature: v1=<hmac>` |

Webhook responses: `200` applied, duplicate, ignored-stale, or unknown send; `400` malformed; `401` bad or stale signature; `429` rate limited; `503` transient failure, which the provider should retry. The raw body of every request that passes the rate limit is stored before any parsing.

**Operations** (no `/v1` prefix on these): `GET /health/live`, `GET /health/ready` (PostgreSQL and Redis), `GET /health`, and `GET /metrics` (Prometheus).

**Admin** (`Authorization: Bearer $ADMIN_API_TOKEN`; `dev-admin-token` in compose): under `/v1/admin`:
- campaign controls: `campaigns/:id/dispatch/{pause,resume}` and `campaigns/:id/cancel`
- dead letters: `campaigns/:id/dead-letters`, `sends/:id/retry`, and `sends/:id/attempts`
- recovery: `outbox/replay`, `campaigns/:id/status-counts/reconcile`, and `queue/{pause,resume}`

[docs/production-runbook.md](docs/production-runbook.md) says when to use each.

## Tests

```bash
npm ci
npm test
```

`npm test` runs every API, dispatcher, worker, and web test. It starts its own disposable PostgreSQL 16 and Redis 7 containers through Testcontainers, so Docker must be running. It doesn't use the compose services.

Load and fault tests run separately against the compose PostgreSQL and Redis, each in its own scratch database:

```bash
npm run load:plan          # 100 branches / 5,000,000 members, crash + resume, latency report
npm run load:dispatch      # dispatcher → BullMQ → workers with injected provider faults and a killed worker
./scripts/backup-restore-drill.sh
```

The measured results are in [docs/production-capacity-report.md](docs/production-capacity-report.md).

## Simulate the provider

Plan campaign 1 first, then run:

```bash
npm run simulate                                   # host; API_BASE_URL defaults to http://localhost:3000
npm run simulate -- --rate 200                     # slower, easier to watch
docker compose exec -e API_BASE_URL=http://localhost:3000 api npm run simulate
```

The simulator talks to the API only over HTTP, and signs each request with `WEBHOOK_SIGNING_SECRET` (default `dev-only-webhook-secret`, matching compose). It:
1. reads every `planned` send from `GET /v1/campaigns/1/sends`;
2. generates one `sent` event and one final event per send, split exactly 85% delivered, 10% undelivered and 5% failed;
3. repeats each event 1–3 times with the same `eventId`, and shuffles all the copies together;
4. posts them with 50 requests in flight, retrying 429s and 5xx responses like a real provider.

A fixed PRNG seed makes runs reproducible.

## Seed and reset

```bash
npm run seed     # idempotent upsert of branches, members, campaign; keeps sends
npm run reset    # DESTRUCTIVE: clears every campaign, send, event, receipt, and seed row, then reseeds
```

These use `DATABASE_URL`, which defaults to the compose database on `localhost:5433`. Inside the container, use `docker compose exec api npm run reset`.

## Layout

```
packages/api/src
  db/migrations  001 demo schema; 002 production delivery model; 003 concurrent indexes; 004 status projection
  campaigns/     local-time planner, resumable production planner, audience snapshots, capacity, routes
  delivery/      dispatch types, claim service (leases, consent/window recheck), send window, operator repo
  outbox/        leased send-outbox repository and BullMQ relay
  webhooks/      signature verification, rate limit, receipts + at-most-once processing, status outbox relay
  live/          SSE hub, Redis Pub/Sub fan-out, status-count reconciliation
  admin/ health/ observability/   operator routes, probes, metrics, JSON logs, OpenTelemetry
  seed/ simulator/                demo data, live smoke campaign, provider simulator
packages/dispatcher/src   due-send loop + reconciliation, retention, process entry points (dispatcher, relay)
packages/workers/src      BullMQ queue + worker, send processor, provider adapters, mock provider
packages/web/src          dashboard (full client snapshot, or server-filtered window for large campaigns)
infra/production          Kubernetes manifests (Kustomize)
```
