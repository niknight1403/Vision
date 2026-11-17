# AutonomAgent

AutonomAgent is an Android-first, Expo/React Native TypeScript workspace for researching product arbitrage and managing a controlled resale workflow.

## Current release posture

- **Default mode:** PAPER (simulation only)
- **Live trading:** disabled
- **Purchases/listings:** require real provider integrations and explicit server-side approval
- **Financial figures:** demo values are labelled; no simulated value is represented as realized revenue
- **Secrets:** provider credentials belong on the server, never in the mobile app or `EXPO_PUBLIC_*`

This repository contains a working Vision analysis code path, but it is not yet a deployed production service. Marketplace sold-data integration, verified marketplace checkout, settlement, Play Store signing/distribution, and production deployment evidence are not included. A reproducible PAPER-only preview APK is produced by the `Android preview APK (PAPER only)` workflow; see [docs/android-preview-apk.md](docs/android-preview-apk.md).

## Vision specialist swarm

The Vision workflow is an asynchronous, server-side analysis pipeline:

1. An ADMIN queues an analysis for an existing product candidate with an HTTPS image URL.
2. The API writes an idempotent `AgentTask` and an audit `OutboxEvent` in one database transaction.
3. The API task worker claims jobs using a database lease and calls the private Python Vision service.
4. The Vision service checks the image source against an exact hostname allowlist, downloads bounded image data, and invokes the configured vision model.
5. Six specialists run in parallel: visual identification, market research, collector rarity, technical/parts, restoration, and risk/authenticity.
6. Results and evidence gaps are persisted on the task and shown in the Android client.

Market research deliberately remains `SKIPPED` until a real sold-listing provider is configured. No model-generated price estimate is presented as verified market evidence. Purchase authorization and authenticity verification are always false.

### Run the Vision stack

- API: `npm run dev --workspace @autonomagent/api`
- API task worker: `npm run worker --workspace @autonomagent/api`
- Python service: from `services/vision-worker`, install `pip install -e .` and run `python -m vision_worker.main`
- Android client: set `EXPO_PUBLIC_API_URL` to the API origin, then run `npm run mobile`

Required server-side environment:
- API and task worker: `DATABASE_URL`, `AUTH_SIGNING_SECRET`, `VISION_WORKER_URL`, `VISION_WORKER_TOKEN`
- Python worker: same `VISION_WORKER_TOKEN`, `VISION_ALLOWED_IMAGE_HOSTS` (exact comma-separated hostnames), `LLM_API_KEY`, `LLM_BASE_URL`, `VISION_MODEL`
- Keep the Python worker on a private network. Never put server secrets in Expo `EXPO_PUBLIC_*` variables.
- Configure outbound network policy to block private, loopback, link-local, and cloud metadata IP ranges; DNS checks alone cannot prevent DNS rebinding.

## Workspace

- `apps/mobile` — Expo Android client with authenticated Vision task submission and live status polling
- `services/api` — Fastify API, durable task queue, and task dispatcher
- `services/vision-worker` — Python image inspection and six-specialist orchestration
- `packages/trading-core` — PAPER-only risk/profit calculation primitives
- `docs` — architecture, deployment, and release gates

The trading core also contains three PAPER-only strategy research primitives:
explainable feature-based signals, risk-bounded portfolio allocation, and
deterministic walk-forward backtesting. They never place orders or call a
broker. See [docs/advanced-strategies.md](docs/advanced-strategies.md).

## Getting started

Requirements: Node.js 22.13+ and npm.

```bash
npm ci
npm run mobile
```

The mobile shell is designed to make the disconnected/demo state explicit. It does not execute real trades.

The PAPER guard that every CI run and the APK build executes can be called directly:

```bash
npm run verify:paper --workspace @autonomagent/mobile
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

## License

No license has been granted yet. All rights reserved unless a separate license is added.


## Lokaler Produktpilot (Demo)

Die Android-App enthält einen explizit gestarteten, deterministischen Demo-Lauf mit lokal festgelegten Produktbeispielen, Cent-basierter Profit-/Risikobewertung, unveröffentlichten Listing-Entwürfen, illustrativen Reichweitenideen und einer Warteschlange für manuelle Prüfung. Der Demo-Lauf selbst startet keine externen Marktplatz-/Werbeaufrufe, Hintergrundjobs, Käufe, Veröffentlichungen oder Freigabeausführung. Separate API-Worker-Bausteine sind nicht mit dem mobilen Demo-Lauf verbunden und werden vom aktuellen Serverstart nicht gestartet. PAPER bleibt aktiv; die API-Konfiguration weist LIVE hart zurück. Preise, Bestände, Margen und Reichweiten sind Beispieldaten, keine Marktdaten oder Prognosen.
