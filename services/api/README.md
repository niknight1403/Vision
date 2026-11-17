# API service boundary

The API is intentionally not wired to live marketplace providers yet.

The repository now contains a disabled, fail-closed testnet safety boundary in
`src/testnet-execution.ts`: approval snapshots, order-state transitions,
kill-switch evaluation, deterministic client-order IDs, a disabled provider
adapter, and reconciliation diff classification. The Prisma schema and
migration persist the corresponding safety records. `testnetEnabled` remains
hard-coded to `false`; no provider host, credential, or mutating HTTP route is
configured.

## Implemented foundation

- Fastify health service with fail-closed configuration.
- Prisma schema for users, wallet accounts, immutable wallet ledger entries, idempotency keys, and outbox events.
- Wallet reservation/release service using a PostgreSQL row lock and Serializable transaction.
- Reservation references are unique; retries with the same reference and matching payload return the current snapshot.
- Vitest checks for integer-cent profit calculations, risk-limit decisions, and bounded worker backoff.
- PostgreSQL outbox worker with `SKIP LOCKED` leasing, expired-lease recovery, retry scheduling, and dead-letter state.
- Agent task lifecycle service with idempotent creation, compare-and-set worker claims, lease-bound checkpoints/completion/failure, and transactional outbox events.
- Bounded agent orchestrator with configurable concurrency, polling, per-claim fencing IDs, periodic lease heartbeats, and graceful AbortSignal shutdown.

## Important boundaries

Wallet functions are internal service primitives, not public routes. They must only be called after authenticated server-side authorization. A release reference must be distinct from its reservation reference. A production execution flow still needs to bind each reservation to an approved trade and enforce per-trade/category/provider limits.

Required before live trading:
- authenticated sessions and server-enforced RBAC;
- server-side secrets vault and provider-specific capability registry;
- complete double-entry accounting for deposits, purchases, fees, sales, payouts, and refunds;
- idempotent execution attempts, durable workers, transactional outbox;
- approval snapshots bound to current price, stock, fees, and expiry;
- server-side emergency stop and reconciliation for unknown order/payment states.

The mobile app must display a disconnected state until authenticated health and operations endpoints are available. Never infer a successful purchase from a request timeout.


## Local product demo boundary

The mobile product-discovery demo uses `packages/trading-core` local fixture data only. Its deterministic demo pipeline assesses illustrative prices, creates unposted listing drafts, and returns channel-fit recommendations with clearly illustrative reach ranges. It has no marketplace or advertising API client, does not persist catalog data, and cannot purchase, publish, approve, or enable live trading. It does not start the separate API outbox worker or agent orchestrator described above; the current API server starts only its health/operations routes. The API configuration hard-rejects `TRADING_MODE=LIVE` and `LIVE_TRADING_ENABLED=true`. Do not treat sample margins or reach spans as current prices, market demand, or measured performance.

## Provider adapter boundary

The API now has a typed provider contract and an explicit capability registry for product search, price lookup, and stock lookup. Registration rejects duplicate or malformed provider IDs, duplicate capabilities, and capabilities without matching adapter methods. Callers must request an adapter through `getForCapability`; merely registering a provider does not grant additional capabilities.

A reusable circuit breaker protects calls in one API process. It opens after a configurable failure threshold, rejects requests while open, permits one probe after cooldown, and closes again after a successful probe. Its state is in-memory and is not coordinated across replicas; production multi-instance deployments need shared provider-health coordination and bounded request timeouts.

No marketplace adapter is connected by this change. The contract deliberately exposes no purchase, payment, listing-publication, or order-modification method. A provider appearing in the registry must never be presented as a live integration unless its official API, authentication, capability scope, and health are independently verified. Keep PAPER mode as the only supported operating mode.

### Outbound provider HTTP boundary

`ProviderHttpClient` is a JSON-only GET client for future read-only adapters. It requires an HTTPS base URL and an exact hostname allowlist supplied by trusted server configuration, rejects paths outside the configured base path, rejects redirects, applies a bounded timeout and response-size limit, and accepts an optional server-side bearer token. It never accepts credentials from mobile requests. Provider adapters must still validate and normalize the returned JSON against provider-specific schemas before using it.

This is transport hardening, not a marketplace integration. No provider host is configured, no secret is provisioned, and no external marketplace request is made by the application at this stage. The response size limit is enforced while streaming the response body, before the full payload is buffered. A declared content length is also checked early. Keep an independent egress/proxy limit in production as defense in depth.


### Server-side provider configuration

`loadProviderRuntimeConfig(providerId, process.env)` reads only the API process environment. For each configured provider, set:
- `PROVIDER_<ID>_BASE_URL`
- `PROVIDER_<ID>_ALLOWED_HOSTS` (comma-separated exact hostnames; no wildcards)
- optional `PROVIDER_<ID>_API_TOKEN` (opaque server-side token)

The loader rejects partial configuration, non-HTTPS endpoints, host mismatches, wildcard hosts, URL credentials/query/fragment, and malformed provider IDs. When no provider variables exist, the provider is returned as disabled. Never serialize the resulting config object, log it, expose it in API responses, or pass it to the mobile application because it may contain a credential. Supply secrets through the deployment platform's secret manager/environment injection; do not commit real values or place them in `EXPO_PUBLIC_*` variables.

This remains configuration plumbing only: no marketplace provider has been selected or connected, and no network request is made during configuration loading. A real adapter must be implemented against a named provider's official read API, validate provider responses, and declare only capabilities actually supported by that API.


### Generic read-only Catalog REST adapter

A generic contract adapter is now available in `src/providers/catalog-rest-adapter.ts`. It expects:
- `GET /health`
- `GET /products?q=<query>&limit=<1..50>&currency=<ISO-4217>`
- a JSON response shaped as `{ "items": [{ "id", "title", "url", "currency", "priceMinor", "observedAt" }] }`

Product payloads are validated and normalized; product links must use HTTPS. The adapter advertises only `PRODUCT_SEARCH`. It has no purchase, listing, payment, or order mutation methods. `bootstrap.ts` registers it only when the `PROVIDER_CATALOG_DEMO_*` server environment is configured.

This is a generic integration contract and test fixture, not a connection to eBay, Amazon, Shopify, or another real marketplace. No provider endpoint or credentials are supplied by default. The registry is not yet exposed through an HTTP route because authenticated sessions and provider-specific authorization are not implemented. Do not enable this adapter against a real service until its official API contract, terms, credentials, and response schema have been reviewed.


### Deal analysis and risk screening

`@autonomagent/trading-core` exports `analyzeDeals` from `src/deal-scanner.ts`. It accepts normalized provider products plus an explicit cost profile (shipping, marketplace/payment fees, packaging, risk reserve) and a resale-price assumption. It calculates expected net profit and ROI with integer-cent/BigInt arithmetic, then applies the existing risk limits.

The scanner currently accepts EUR only; it rejects other currencies rather than silently converting them. It also rejects duplicate provider identities and invalid minor-unit prices. `approvedByRiskRules` means only that the supplied numeric candidate passed the configured rules; it is not purchase authorization, a guarantee of sale, realized profit, or a signal to execute a trade. The scanner does not reserve funds or create orders.


The same package also exports `scanProviderDeals(provider, request, signal?)`. This composes a provider's declared `PRODUCT_SEARCH` capability with the analysis function: it bounds query/limit, requires EUR until conversion is implemented, propagates abort signals, rejects over-sized provider responses, and analyzes only records actually returned by that provider. An empty provider response stays empty; no sample products are substituted.

This pipeline is currently a reusable core function, not an HTTP endpoint. The API deliberately does not expose it publicly until authenticated sessions, authorization, and persisted audit controls are in place.


### Persisted deal review queue

The Prisma schema and SQL migration add `DealCandidate`, uniquely keyed by provider plus external product ID. `persistDealCandidates` upserts batches of up to 100 observations in a serializable transaction. Every new observation resets its review state to `DISCOVERED` and clears prior reviewer metadata so an old review cannot silently carry over to changed prices or risk assumptions.

`listDealCandidates` supports status/risk filters and a bounded result count. `reviewDealCandidate` is an internal primitive that must only be called after authenticated ADMIN authorization; it rejects approval of simulated or risk-failing records and uses a compare-and-set update to prevent concurrent review races. An APPROVED label is only a human review outcome: it does not authorize or execute a purchase.

Migration `20261117014300_deal_candidates` adds this table and runs after `20261117013700_initial_schema`. Run Prisma migration deployment only after reviewing the migration and confirming the target database. Development databases created before the migration reordering must be reset.


### API deal-scan composition

`src/deal-scan-service.ts` now connects the configured provider registry to the shared trading-core scanner and the persistent review queue. `runAndPersistDealScan` resolves only a registered provider with `PRODUCT_SEARCH`, analyzes the provider's actual read-only results, checks cancellation before persistence, and stores the resulting candidates. Its return value contains counts only, not provider credentials or raw payloads.

This is an internal service function, not a public route or an automatically scheduled job. It must be called only by a future authenticated, authorized operator workflow. The API workspace declares the shared trading-core dependency; its TypeScript build emits the shared source under the API build output, so the production start script targets `dist/services/api/src/server.js`. The lockfile was updated with the workspace dependency. No install, typecheck, test, migration, or deployment has been run as part of this source change.


### Authentication and database-backed RBAC primitive

`src/auth-service.ts` adds a reusable bearer-token verifier for short-lived HS256 JWT access tokens. It requires a server-side signing secret of at least 32 bytes, a fixed issuer/audience, a maximum 15-minute token lifetime, valid time claims, and a valid signature. It then reloads the user's current role and disabled state from PostgreSQL; any role claim embedded in the token is ignored. `requireAdmin` checks that database-backed principal.

This is an authentication primitive only. There is deliberately no login/token-issuing endpoint, password reset flow, refresh-token store, session revocation system, or public deal-review route yet. A trusted issuer must provision tokens using the documented issuer/audience and HS256 contract, and the API deployment must supply the same high-entropy secret through its secret manager. Do not put this secret in the mobile app, source control, or `EXPO_PUBLIC_*`. Until a trusted issuer, key rotation, rate limiting, audit logging, and authenticated route integration are in place, the review queue remains internal and inaccessible over HTTP. The test suite has been added but has not been executed in this environment.


### Password login and rotating refresh sessions

`src/auth-session-service.ts` adds:
- password hashing and verification with Node.js scrypt (fixed work parameters, per-password random salt, 32-byte derived key);
- credential login with a generic invalid-credentials response for unknown, disabled, or incorrect accounts;
- 15-minute HS256 access-token issuance using the same issuer/audience contract as `auth-service.ts`;
- cryptographically random refresh tokens, with only SHA-256 token hashes stored in PostgreSQL;
- one-time refresh rotation inside a Serializable transaction, using a conditional update so concurrent reuse cannot successfully rotate the same session;
- refresh-token revocation.

The Prisma `RefreshSession` model and migration `20261117010000_auth_sessions` are committed. The migration has **not** been applied. Passwords must be at least 12 and no more than 128 UTF-8 bytes. Existing user creation and initial ADMIN bootstrap are intentionally not exposed; provision the first administrator through a controlled out-of-band process. Never make public self-registration assign ADMIN.

These are internal service primitives only. No login, refresh, logout, or deal-review HTTP routes are wired to Fastify yet. Before exposing them, add strict request schemas, TLS-only deployment, login rate limiting and abuse controls, CSRF protection if cookies are used, key rotation strategy, security audit events, and operational session cleanup. Keep refresh tokens out of logs and browser local storage; mobile clients should use platform secure storage. The API must receive the signing secret from its deployment secret manager. The added unit tests have not been executed here.

### Authenticated HTTP routes (RBAC)

`src/app.ts` exports `buildServer`, which `src/server.ts` starts; tests drive the same instance through `app.inject()`.

| Route | Authorization | Behavior |
| --- | --- | --- |
| `GET /health` | public | Service and safety flags, `tradingReady: false` |
| `POST /v1/auth/login` | public | Issues an HS256 access token (15 min) plus a rotating refresh token (30 days) |
| `POST /v1/auth/refresh` | refresh token | One-time rotation; reuse of a rotated token returns 401 |
| `POST /v1/auth/logout` | refresh token | Revokes the presented refresh session, 204 |
| `GET /v1/deals` | any authenticated role | Review queue with `reviewStatus`, `riskPassed` and `limit` (1..100) filters |
| `POST /v1/deals/:dealId/review` | ADMIN only | `APPROVED`, `REJECTED` or `ARCHIVED`; 422 for simulated or risk-failing approval, 409 on a concurrent or repeated decision |

Access control is enforced per request: `authenticateBearerToken` verifies the signature and then reloads the user's role and `disabledAt` from PostgreSQL, so a role change or a disabled account takes effect without waiting for the token to expire. Cent amounts are serialized as strings to keep them JSON-safe.

The routes expose review decisions only. There is still no purchase, reservation, listing-publication or payout endpoint, and approving a candidate never reserves funds or contacts a provider. `AUTH_SIGNING_SECRET` (at least 32 bytes) must come from the deployment environment; without it the auth routes fail closed with 503. Login has no additional rate limiting beyond the constant-time dummy-hash comparison, so a public deployment needs a reverse-proxy or gateway throttle.
