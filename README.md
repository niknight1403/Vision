# AutonomAgent

AutonomAgent is an Android-first, Expo/React Native TypeScript workspace for researching product arbitrage and managing a controlled resale workflow.

## Current release posture

- **Default mode:** AUTONOMOUS (real provider data and server-side analysis)
- **Live trading:** disabled
- **Purchases/listings:** require real provider integrations and explicit server-side approval
- **Financial figures:** only provider observations are accepted; no estimate is represented as realized revenue
- **Secrets:** provider credentials belong on the server, never in the mobile app or `EXPO_PUBLIC_*`

This repository contains a working Vision analysis path and a real provider-driven deal scan. A named marketplace checkout, settlement, Play Store signing/distribution, and production deployment evidence still require the provider's official API contract and deployment credentials; the application does not fabricate these capabilities.

## Vision specialist swarm

The Vision workflow is an asynchronous, server-side analysis pipeline:

1. An ADMIN queues an analysis for an existing product candidate with an HTTPS image URL.
2. The API writes an idempotent `AgentTask` and an audit `OutboxEvent` in one database transaction.
3. The API task worker claims jobs using a database lease and calls the private Python Vision service.
4. The Vision service checks the image source against an exact hostname allowlist, downloads bounded image data, and invokes the configured vision model.
5. Six specialists run in parallel: visual identification, market research, collector rarity, technical/parts, restoration, and risk/authenticity.
6. Results and evidence gaps are persisted on the task and shown in the Android client.

Market research remains unavailable until a real sold-listing provider is configured. No model-generated price estimate is presented as verified market evidence. Purchase authorization and authenticity verification are always false.
Model-generated source links and comparable sales are discarded by the specialist adapter because the product brief contains no verified source URLs; the result records that evidence gap.

### Run the Vision stack

- API: `npm run dev --workspace @autonomagent/api`
- API task worker: `npm run worker --workspace @autonomagent/api`
- Python service: from `services/vision-worker`, install `pip install -e .` and run `python -m vision_worker.main`
- Android client: set `EXPO_PUBLIC_API_URL` to the API origin, then run `npm run mobile`

Required server-side environment:
- API and task worker: `DATABASE_URL`, `AUTH_SIGNING_SECRET`, `VISION_WORKER_URL`, `VISION_WORKER_TOKEN`
- Python worker: same `VISION_WORKER_TOKEN`, `VISION_ALLOWED_IMAGE_HOSTS` (exact comma-separated hostnames), `LLM_API_KEY`, `LLM_BASE_URL`, `VISION_MODEL`
- Python worker limits (optional): `VISION_MAX_CONCURRENT_ANALYSES` (default 4, 503 `WORKER_BUSY` when exhausted), `VISION_ANALYSIS_TIMEOUT_SECONDS` (default 90, 504 `WORKER_TIMEOUT`), `VISION_SHUTDOWN_GRACE_SECONDS` (default 20, drains in-flight analyses on shutdown). Request bodies are capped at 64 KiB and every response carries an `x-request-id`; `/health` is liveness, `/ready` is readiness.
- Metrics (optional): set `METRICS_TOKEN` (at least 16 characters) to open `GET /metrics` for Prometheus; without it the route answers 503. Requests are counted per route template, plus outbox and agent-task gauges.
- Rate limits (optional): `AUTH_RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_WINDOW_MS` (default 10 per 60 s per client IP), `SCAN_RATE_LIMIT_MAX`/`SCAN_RATE_LIMIT_WINDOW_MS` (default 30 per 60 s per user), `ANALYSIS_RATE_LIMIT_MAX`/`ANALYSIS_RATE_LIMIT_WINDOW_MS` (default 20 per 60 s per user) and `RATE_LIMIT_MAX_KEYS` (default 10 000 tracked keys). A refused request answers 429 with `Retry-After` and `x-ratelimit-remaining`; an out-of-range value aborts startup instead of silently disabling the limit.
- Keep the Python worker on a private network. Never put server secrets in Expo `EXPO_PUBLIC_*` variables.
- The worker resolves the allowlisted host once, rejects every non-public answer, and then connects to that exact validated address while still verifying the certificate and SNI for the hostname, so a second lookup cannot redirect the download (no DNS rebinding). Redirects are never followed. Keep an outbound network policy at the container/VPC layer as defence in depth: the code proves the pinning, it cannot prove the deployment's firewall.

## Workspace

- `apps/mobile` — Expo Android client with authenticated Vision task submission and live status polling
- `services/api` — Fastify API, durable task queue, and task dispatcher
- `services/vision-worker` — Python image inspection and six-specialist orchestration
- `packages/trading-core` — integer-cent risk/profit calculation primitives
- `docs` — architecture, deployment, and release gates

The trading core also contains three offline strategy research primitives:
explainable feature-based signals, risk-bounded portfolio allocation, and
deterministic walk-forward backtesting. They never place orders or call a
broker. See [docs/advanced-strategies.md](docs/advanced-strategies.md).

## Getting started

Requirements: Node.js 22.13+ and npm.

```bash
npm ci
npm run typecheck
npm test
```

Configure the server-side real catalog adapter before scanning:

```bash
PROVIDER_CATALOG_LIVE_BASE_URL=https://provider.example/api/
PROVIDER_CATALOG_LIVE_ALLOWED_HOSTS=provider.example
PROVIDER_CATALOG_LIVE_API_TOKEN=server-side-token
```

The provider must implement `GET /health` and `GET /products?q=&limit=&currency=` with the documented JSON contract in `services/api/src/providers/catalog-rest-adapter.ts`. No fixture products are substituted when it is absent.

The mobile shell consumes authenticated provider-backed candidates and analysis results. It does not claim a purchase or publication unless a separately reviewed mutating adapter is installed.

The production type and unit checks can be called directly:

```bash
npm run typecheck && npm test
```

## Safety gates before any live use

1. Implement authenticated server-side sessions and ADMIN/OPERATOR/VIEWER authorization.
2. Implement an immutable, double-entry wallet ledger and atomic capital reservations.
3. Add durable jobs, transactional outbox, idempotency, leases, and reconciliation.
4. Integrate each marketplace only through its official supported API and explicit capability flags.
5. Require a fresh price/stock/fee check and explicit administrator approval for every purchase.
6. Keep a server-side emergency stop and make unknown order/payment states reconcile-only.
7. Pass automated unit, integration, concurrency, security, and Android install tests.
8. Publish build IDs, artifact hashes, migration status, and health-check evidence before calling a release production-ready.

See [docs/architecture.md](docs/architecture.md) and [docs/release-gates.md](docs/release-gates.md).
The evidence for Sprints 21–30 is recorded in [docs/thirty-sprint-release-gate.md](docs/thirty-sprint-release-gate.md) and for Sprints 31–40 in [docs/forty-sprint-release-gate.md](docs/forty-sprint-release-gate.md). Both are source/test gates, not production approvals.

## Verified checks (Sprints 31–40)

All commands below were actually executed on 2026-11-23 against the local repository; the numbers are the observed output, not targets:

| Command | Result |
| --- | --- |
| `npm run typecheck` | green (mobile, api, trading-core) |
| `npm test` | green — 198 tests in 32 files (mobile 43, api 112, trading-core 43) |
| `npm run test:db --workspace @autonomagent/api` | green — 37 tests in 7 files, 0 skipped (33 integration tests in 6 files) against local PostgreSQL |
| `npm run test:python` | green — 68 passed, 0 skipped |
| `npm run audit:gate` | green — 0 advisories |
| `npm run build --workspace @autonomagent/api` | green — TypeScript build emitted |
| `npx expo export --platform android` | green — Hermes bundle, 603 modules |
| `node scripts/backup-restore-drill.mjs` | PASSED — 14 tables, 9 migrations, dump 39 540 bytes |

Still unproven: no device/emulator run, no end-to-end test against a running API, no live marketplace mutation, no provider credentials, no PITR/offsite backup, no gateway-shared rate limit, no load tests and no production deployment. See the blocker list in the gate document.

## License

No license has been granted yet. All rights reserved unless a separate license is added.
