# ADR: Tenant isolation and legacy-data migration

- Status: Proposed; implementation gate for Sprint 2
- Date: 2026-11-20
- Scope: API identity, wallets, agent tasks, shared deal catalogue and tenant-owned review decisions

## Context

The current schema has users but no tenant or membership model. WalletAccount and AgentTask carry ownerId only. AgentTask.idempotencyKey is globally unique. DealCandidate is a provider-ingested catalogue row, but currently also stores reviewStatus/reviewedBy/reviewedAt. Provider scans upsert the catalogue independently of a requesting tenant. A tenant migration must not infer ownership for shared catalogue observations or silently convert historical global review state into tenant approvals.

## Decision

1. Introduce Tenant and TenantMembership. A membership is the authorization boundary; a user's global UserRole is not a tenant role. Membership roles are OWNER, ADMIN, OPERATOR, VIEWER. The platform role, if later required, is separate and explicit.
2. Resolve active tenant context from the authenticated principal plus a verified membership. A client-supplied tenant ID is only a selector and must be checked against membership on every request. Never accept role or owner claims from request bodies.
3. Keep DealCandidate as a shared, provider-observed catalogue. It does not gain tenantId. Remove tenant-specific review state from its domain in a later API/schema cutover and introduce DealReview with tenantId, candidateId, reviewerUserId, decision, reviewedAt, createdAt, updatedAt and unique(tenantId,candidateId). Deal list queries may expose catalogue observations but review filters and decisions must be tenant-scoped.
4. Add tenantId to WalletAccount and AgentTask. Wallet ownership policy: tenant-owned account with ownerUserId retained as the creator/audit actor; access requires tenant membership plus an explicit permission. Do not treat ownerId as an authorization substitute.
5. Change AgentTask idempotency uniqueness to (tenantId,idempotencyKey). All lookup, conflict recovery, status reads, task creation and service entry points must include verified tenantId. IdempotencyKey scope is server-composed from tenantId and operation; never accept a raw scope from the caller.
6. Workers may claim across tenants as infrastructure, but task input/result access remains tenant-bound at API/service boundaries. Worker identity and lease ownership are not tenant authorization.
7. Keep trading execution disabled. No migration or tenant feature may enable live trading.

## Legacy data migration policy

Use an expand/backfill/validate/contract sequence with a maintenance or feature-flagged cutover:

- Create Tenant and TenantMembership first.
- Deterministic personal-tenant backfill is permitted only for resources with a provable user owner: create one personal tenant per existing User and OWNER membership; map WalletAccount and AgentTask from their existing ownerId to that user's personal tenant.
- Abort migration if any wallet/task ownerId has no corresponding User. Do not invent a fallback tenant.
- DealCandidate rows remain shared catalogue observations and are not assigned to a tenant.
- Historical DealCandidate reviewStatus/reviewedBy/reviewedAt are ambiguous global state. Preserve them in a read-only legacy/quarantine table or archive snapshot with source IDs and timestamps. Do not synthesize tenant DealReview rows from them.
- Existing AgentTask idempotency keys are preserved. The uniqueness change must be checked for duplicates per proposed tenant before applying the new composite constraint; fail migration on collision and report affected task IDs.
- Do not expose tenant-owned routes until every tenant-owned row has a valid tenantId and membership checks are enforced. Missing/ambiguous ownership fails closed.

## Required API and test gates

- Tenant context resolver verifies active membership and tenant role from the database.
- Cross-tenant negative tests for deal reviews, wallet read/write/ledger, task create/read/idempotency and administrative routes.
- Two users in one tenant test shared access according to membership role; users in separate tenants cannot see or mutate each other's tenant-owned data.
- A global catalogue scan cannot create, overwrite or clear tenant review decisions.
- Migration tests cover empty database, existing single-user records, orphan owner IDs, duplicate idempotency keys, and ambiguous legacy review state.
- Prisma validate, migration deploy on PostgreSQL, API typecheck/build, unit tests and PostgreSQL integration tests all pass.
- CI evidence is tied to the exact PR head SHA. No direct-to-main commits.

## Rollout order

1. Merge this ADR after review.
2. Implement schema and reversible/guarded migration.
3. Implement membership resolver and tenant-aware auth context.
4. Move review decisions to tenant-owned DealReview and adapt endpoints.
5. Tenant-scope wallet and task services plus idempotency.
6. Add two-tenant integration suite; only then enable tenant-owned routes.
7. Remove legacy global review fields after all consumers are migrated and legacy snapshot is verified.

## Explicit non-goals

- No automatic tenant inference from email domain.
- No cross-tenant ADMIN bypass.
- No automatic migration of global deal approvals.
- No live trading or financial execution enablement.
