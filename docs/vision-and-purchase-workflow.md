# Vision inspection and controlled purchase workflow

## Hidden Treasure Swarm (architecture and acceptance contract)

The product-analysis pipeline is designed as a coordinated set of specialist agents. The orchestrator must not decide from a single model response. It dispatches bounded specialist tasks, preserves each specialist's evidence and uncertainty, and produces a consolidated candidate report.

### Specialist roles

1. **Visual identification specialist** — reads labels, logos, markings, model numbers, revisions, components, accessories, and visible condition. It must distinguish observed text from OCR guesses.
2. **Market research specialist** — gathers recent, comparable sold listings from approved marketplace/search adapters. Asking prices are not sold prices. Without retrieved comparables, it must return `market_status: "RESEARCH_REQUIRED"` and no fabricated valuation.
3. **Collector and rarity specialist** — checks editions, production runs, variants, discontinued lines, provenance clues, and collector demand. Rarity claims require a source or are marked unverified.
4. **Technical specialist** — identifies part numbers, compatibility, repairability, replacement-part demand, and whether an apparently incomplete item may still be useful.
5. **Restoration specialist** — estimates cleaning, repair, missing parts, labor, and parts cost. It must separate confirmed defects from visual assumptions.
6. **Risk and authenticity specialist** — flags counterfeit indicators, safety concerns, legal restrictions, hidden damage, and conflicts between specialist findings. A visual model score is never an authenticity certificate.

### Swarm orchestration

- Create one durable analysis task per candidate and fan out specialist subtasks with a shared correlation ID.
- Run independent specialists concurrently with bounded timeouts, retries, and per-provider rate limits.
- Keep each result separate: role, status, findings, evidence/source references, confidence, unknowns, and timestamp.
- A synthesis/critic step checks contradictions and requests targeted re-analysis when evidence is insufficient.
- Never convert missing evidence into a positive claim. A low-confidence candidate may be queued for more photos or manual inspection.
- Store raw specialist results and the consolidated report for auditability; do not overwrite the original listing facts.
- The mobile app should show live specialist states (QUEUED, RUNNING, SUCCEEDED, FAILED), not simulated progress.

### Treasure score and decision

The score is a prioritization signal, not a guarantee. It should weigh:
- evidence-backed resale value and comparable-sale freshness;
- acquisition price plus shipping, fees, taxes, repair, missing parts, and risk reserve;
- demand/liquidity and estimated time to sell;
- rarity/collector signals only when supported by evidence;
- uncertainty, authenticity concerns, and downside risk.

Return an explicit value range only when sufficient market evidence exists. Otherwise return `valuationStatus: "RESEARCH_REQUIRED"`. Keep gross resale value, all-in cost, expected net profit, and confidence as separate fields. Do all currency calculations in integer minor units.

### Safety boundary

The Swarm may discover, research, rank, and recommend. It may not contact sellers, make offers, reserve goods, or pay for products as a side effect of analysis. Those actions require a separate ADMIN approval and the controlled purchase workflow below.

## Vision worker (implemented scaffold)

The isolated Python worker under `services/vision-worker` uses an async OpenAI-compatible client and validates model output with Pydantic. Configure `LLM_API_KEY`, `LLM_BASE_URL`, and `VISION_MODEL` on the worker only. Configure the exact image host allowlist in the worker deployment and pass it as `allowed_hosts`.

The downloader requires HTTPS, an exact allowlisted hostname, public DNS answers, no redirects, a supported image MIME type, matching file signatures, and an 8 MiB maximum. Production deployment must additionally enforce outbound network policy at the container/VPC layer to prevent DNS rebinding and access to metadata/private networks. The TypeScript API exposes POST /v1/deals/:dealId/vision-inspection behind ADMIN authorization. The worker adapter now exists: `services/api/src/vision-inspector.ts` posts the image URL and the stored deal title to the worker's `POST /v1/visual-inspection` with the shared bearer secret, caps the round trip with a timeout, and maps failures to 502 VISION_WORKER_UNAVAILABLE, 502 VISION_WORKER_REJECTED, 502 VISION_WORKER_RESPONSE_INVALID or 504 VISION_WORKER_TIMEOUT. `server.ts` wires it only when both VISION_WORKER_URL and a VISION_WORKER_TOKEN of at least 32 characters are present; without them the route keeps answering 503 VISION_INSPECTOR_NOT_CONFIGURED, and a malformed configuration disables the route instead of blocking API startup. The route returns explicit purchaseAuthorized: false and authenticityVerified: false flags and does not persist the result yet. The image-host allowlist stays in the worker, which owns the downloader; the API never fetches user-supplied URLs itself and never treats the model's visual score as an authenticity certificate.

The worker exposes two routes behind the same bearer secret: `POST /v1/analyze` runs the full specialist swarm and valuation for a durable AgentTask, and `POST /v1/visual-inspection` returns only visual evidence for the API's deal route. Both refuse anything but the exact configured token.

The worker package now contains a parallel HiddenTreasureSwarm orchestrator, evidence-backed scoring, typed specialist findings, and OpenAI-compatible adapters for visual, collector, technical, restoration, and risk analysis. The orchestrator enforces bounded concurrency/timeouts, reports missing or failed specialists, compares explicit model identifiers, and only values products when the market adapter supplies at least two recent HTTPS-sourced sold comparables in the candidate currency. Without a real market provider, market research is SKIPPED and valuation remains RESEARCH_REQUIRED. These Python components are implemented and covered by tests. Durable task execution exists in `services/api/src/agent-task-worker.ts`, which claims AgentTask rows, calls the worker with the same bearer secret and persists result or failure. What remains is the actual deployment of API, database and worker, an approved marketplace sold-data provider, and the mobile UI for the swarm states.

## Running the analysis pipeline (private deployment)

The API and Python worker are separate processes. Apply the existing Prisma migrations, start the API, and start the worker command from the repository root:

- API: `npm run dev --workspace @autonomagent/api`
- Task dispatcher: `npm run worker --workspace @autonomagent/api`
- Python specialist service: from `services/vision-worker`, install with `pip install -e ".[test]"` and run `python -m vision_worker.main`.

Configure the API task dispatcher with `VISION_WORKER_URL` pointing to the private worker service and `VISION_WORKER_TOKEN` with a random secret of at least 32 characters. Configure the Python service with the same `VISION_WORKER_TOKEN`, `VISION_ALLOWED_IMAGE_HOSTS` as a comma-separated list of exact approved image hostnames, and the LLM variables `LLM_API_KEY`, `LLM_BASE_URL`, and `VISION_MODEL`. Keep the Python service on a private network; do not expose port 8091 publicly. The API worker polls durable AgentTask rows, claims them with a lease, retries transient failures up to maxAttempts, and persists the result/status. The OutboxEvent is written atomically with the task for downstream audit/dispatch.

The queue is functional for visual and LLM specialist analysis once both processes and credentials are deployed. Market research remains explicitly unavailable until an approved sold-listing provider is configured; results therefore remain RESEARCH_REQUIRED and cannot claim a verified resale value. The API does not mark a task complete merely because it was queued.

## Purchase workflow (design boundary; not an active integration)

The existing API supports authenticated deal review, not marketplace purchases. Do not add a generic Playwright login-and-send implementation or claim that a purchase succeeded when a background task was merely queued.

A future provider adapter must be explicitly registered with narrow capabilities and must use the provider's supported official API. The execution workflow must:
1. Require a fresh ADMIN authorization and a separate, explicit execution confirmation.
2. Load the persisted candidate; never accept a target URL or price supplied by the mobile client.
3. Re-fetch current listing state and price through the approved provider adapter.
4. Compare the final all-in cost (item, shipping, platform/payment fees, tax, packaging, risk reserve) with the approved maximum in integer minor units.
5. Enforce PAPER mode, server-side kill switch, provider/category/user limits, approval expiry, and idempotency.
6. Persist an immutable execution attempt and audit event before external side effects.
7. Return `accepted` only when a durable job is stored; report `submitted`, `confirmed`, `failed`, or `unknown` only from verified provider outcomes.
8. Require manual confirmation before sending a binding offer or initiating payment unless the administrator has separately enabled a narrowly scoped, capped automation policy.

Unknown provider outcomes must be reconciled; never blindly retry a purchase or message. No live provider, purchase endpoint, payment flow, or automated seller contact is enabled by this document.


## Android Vision client

The Expo dashboard now signs in against the Fastify API, lists persisted product candidates, accepts a HTTPS image URL per candidate, queues an ADMIN-only specialist analysis, and polls the durable task status. The UI renders specialist status, score, valuation evidence, conflicts, and next actions. Configure `EXPO_PUBLIC_API_URL` at build time. This variable is only the public API origin; never place credentials or provider keys in Expo public variables.

The current client expects an ADMIN account for enqueueing. A VIEWER or OPERATOR can authenticate but will receive the server's authorization error when trying to start a specialist analysis.

## Release readiness

A green CI run verifies code, Prisma migrations, API tests, Python tests, dependency audit, the Expo Android JavaScript export, and the worker bearer-token handshake: the `worker-auth` job boots the private worker with the repository secret `VISION_WORKER_TOKEN`, proves `/health` answers, and proves `/v1/analyze` returns 401 without a token, 401 with a wrong token, and 200 with the configured secret. The job fails if the secret is missing or shorter than 32 characters, so a missing deployment secret breaks the pipeline instead of silently shipping an unauthenticated worker. It does not create a signed APK/AAB, provision production secrets, deploy the API/database/worker, configure an approved marketplace sold-data provider, or publish a production release. Those remain separate deployment and distribution gates.
