# Gym SMS campaign

Plans the "Win-back October" SMS campaign for three gym branches in each branch's local time, ingests idempotent delivery webhooks from an SMS provider, and shows live per-branch and per-send status.

- **API**: Node.js, TypeScript, Express, PostgreSQL (`packages/api`)
- **Web**: React, TypeScript, Vite, SSE, virtualized table (`packages/web`)
- **Tests**: Vitest, Supertest, Testcontainers PostgreSQL

## Run it

```bash
docker compose up --build
```

| What | URL |
| --- | --- |
| Campaign dashboard | http://localhost:8080 |
| API (direct) | http://localhost:3000 |
| PostgreSQL | `postgres://gym:gym@localhost:5433/gym` |

On startup the API runs migrations, then seeds the data, and only then starts listening. Its health check passes only after that, and the web container waits for it. The seed creates three branches, 5,000 members and campaign 1 ("Win-back October", 2026‑10‑23 → 2026‑10‑29). Restarting is safe: the seed is an idempotent upsert and never touches sends.

Campaign 1 starts **unplanned**. Click **Plan campaign** on the dashboard, or run:

```bash
curl -X POST http://localhost:3000/v1/campaigns/1/plan
```

Planning stores one send per member with a calculated UTC `scheduledAt`. It never sends anything and starts no timers. Running it again, or running it concurrently, returns the same plan.

## API

The API is versioned by URL path, and `/v1` is the current version. Timestamps are ISO‑8601 UTC.

- **Canonical paths** start with `/v1`, for example `/v1/campaigns/1/summary`. The dashboard and the simulator both use them.
- **Unversioned paths** from the original spec (`/campaigns/...`, `/webhooks/provider`, with no `/api` prefix) still work. They are a permanent alias **pinned to v1**, so a future v2 never changes what they return. A provider webhook URL that is already configured keeps working.
- Every versioned or aliased response carries an `API-Version: v1` header.
- An unknown version such as `/v2/...` returns `404 {"error":"unsupported_api_version","supportedVersions":["v1"]}`.
- `/health` is infrastructure and stays unversioned.

| Method & path (prefix with `/v1`) | Purpose |
| --- | --- |
| `POST /campaigns/:id/plan` | Create the plan once. Returns `201` when it is created and `200` when it already exists; both include branch/status counts |
| `GET /campaigns/:id/summary` | Status counts per branch (zeros included), plus the earliest and latest `scheduledAt` |
| `GET /campaigns/:id/sends?branchId=&status=&cursor=&limit=` | Keyset pagination by send id. `limit` defaults to 100, max 1000. Follow `nextCursor` |
| `GET /campaigns/:id/events` | SSE stream: a `ready` frame, then `send.updated` for each committed status change |
| `POST /webhooks/provider` | Provider callback `{ eventId, sendId, status, occurredAt }` |
| `GET /health` | Liveness and database check |

## Tests

```bash
npm ci
npm test
```

`npm test` runs every API and web test. The API tests start their own disposable PostgreSQL 16 container through Testcontainers, so Docker must be running. It doesn't use the compose database.

## Simulate the provider

Plan the campaign first, then run the simulator from the host:

```bash
npm ci                                   # once, for host-side scripts
npm run simulate                         # API_BASE_URL defaults to http://localhost:3000
API_BASE_URL=http://localhost:3000 npm run simulate -- --rate 200   # slower, easier to watch
```

Or run it inside the API container:

```bash
docker compose exec -e API_BASE_URL=http://localhost:3000 api npm run simulate
```

The simulator talks to the API only over HTTP. It reads every `planned` send from `GET /v1/campaigns/1/sends`, posts to `/v1/webhooks/provider`, then generates one `sent` event and one final event per send, split exactly 85% delivered, 10% undelivered and 5% failed. Each event is repeated 1–3 times with the same `eventId`, and all copies are shuffled together. It posts with 50 requests in flight. `--rate N` caps request starts per second, and `--concurrency`, `--seed` and `--campaign` are also available. A fixed PRNG seed makes runs reproducible. For the seeded plan that means 4,640 sends, 9,280 logical events and 9,280–27,840 HTTP requests. Running it again is harmless: nothing is still `planned`, and reused event IDs would be acknowledged as duplicates.

## Seed and reset

```bash
npm run seed     # idempotent upsert of branches, members, campaign; keeps sends
npm run reset    # DESTRUCTIVE: clears sends, provider events, raw receipts and seed rows, then reseeds
```

After `reset`, campaign 1 is unplanned again. Plan it to get a fresh schedule, which is identical because planning is deterministic. These scripts use `DATABASE_URL`, which defaults to the compose database on `localhost:5433`. Inside the container, use `docker compose exec api npm run reset`.

## Layout

```
packages/api/src
  db/          pool, migration runner, 001_initial.sql (constraints + transition trigger)
  seed/        deterministic seed data, seed + reset
  versioning.ts  /v1 mounting, unversioned v1 alias, unknown-version 404s
  campaigns/   pure local-time planner, repository (plan/summary/keyset), routes
  webhooks/    payload schema, receipt + at-most-once processing service, route
  live/        publisher contract, in-process SSE hub, SSE route
  simulator/   deterministic event generation, bounded HTTP dispatch, CLI
packages/web/src
  api/         typed client
  lib/         LiveStore (statusVersion merge, count deltas), time formatting
  hooks/       useCampaignLiveData (SSE first, snapshot, reconnect, per-frame flush)
  components/  BranchSummary, SendsTable (virtualized), StatusBadge
```

Design decisions and trade-offs are in [NOTES.md](NOTES.md).
