# Wallet lifecycle and journal policy — decision draft

**Status:** Proposal for review; not an approved accounting policy.  
**Scope:** Sprint 3.2 / Issue #33. This document deliberately does not enable payment execution.

## 1. Current implementation facts

The inspected wallet service currently implements only:

- RESERVATION: increases WalletAccount.reservedCents after checking available funds and appends a wallet-ledger row.
- RESERVATION_RELEASE: decreases reservedCents, linked to the source reservation, and appends a release row. Cumulative partial releases are bounded by the original reservation.

Neither operation changes balanceCents. The wallet schema defaults balanceCents to zero. The wallet service currently has no implemented deposit, purchase, marketplace fee, shipping, seller settlement, payout, refund, chargeback, or manual-adjustment mutation. Enum values for these types are not executable workflows.

The journal service accepts generic balanced postings, but it does not currently derive or authorize postings from wallet lifecycle events. The read-only reconciliation code must not be mistaken for a financial posting path.

## 2. Non-negotiable invariants

1. All money is integer minor units (BigInt cents); no floating-point amounts.
2. Currency is explicit on every wallet and journal transaction. No implicit FX conversion.
3. Every command is tenant-scoped and must resolve the wallet through (tenantId, ownerId, accountId).
4. A retry with the same business idempotency key and identical canonical payload returns the original result; a different payload is a conflict.
5. Source event identity, provider identity, tenant, currency, amount, and relevant order/reservation identifiers are persisted for audit.
6. Wallet counters, wallet-ledger rows, journal postings, and outbox records must commit or roll back atomically when a supported financial command changes more than one of them.
7. Posted journal history is append-only. Corrections are new compensating transactions, never edits.
8. External callbacks are authenticated and signature-verified before becoming authoritative state transitions.
9. A pending/unknown external payment state must never be represented as settled funds.
10. Manual adjustments require explicit permissions, reason, evidence, and independent approval (dual control); the requester cannot approve their own adjustment.
11. Reconciliation drift places the affected workflow/account on hold and raises an auditable operational alert; it must not silently rewrite balances.
12. PAPER/test fixtures are never evidence of real customer funding.

## 3. Lifecycle decision matrix

| Event | Required authoritative evidence | Wallet effect | Journal mapping | Status |
|---|---|---|---|---|
| Opening balance | Approved migration/import manifest, source statement, owner/tenant/currency, effective time, unique reference | One-time controlled initialization only | Counter-account and cutover policy not decided | **Blocked** |
| Funding initiated | Authenticated provider intent/reference | No spendable balance increase | No posting | Not implemented |
| Funding confirmed | Verified provider settlement/capture event and immutable provider event ID | Credit only after confirmed state; duplicate event is a no-op | Clearing/cash counterpart and timing not decided | **Blocked** |
| Funding failed/reversed/chargeback | Verified provider failure/reversal/dispute event | Hold/reverse only according to approved provider state model | Reversal and loss-account policy not decided | **Blocked** |
| Reservation | Authorized order/deal intent and stable reservation reference | Increase reserved amount; do not change total balance | Available/reserved subaccount treatment not decided | Implemented as hold only |
| Partial/full reservation release | Authorized cancellation/expiry/fulfilment outcome, source reservation reference | Decrease reserved amount, cumulative release <= original reservation | Matching subaccount treatment not decided | Implemented as hold release only |
| Buyer purchase/capture | Authoritative order transition plus provider capture/escrow evidence | Debit/consume according to approved capture model | Principal, fee, tax, shipping, clearing and seller payable mapping not decided | **Blocked** |
| Marketplace fee | Contractual fee schedule/version and eligible settled order | No independent mutation absent purchase settlement | Revenue/tax treatment not decided | **Blocked** |
| Seller settlement/payout | Approved payable plus provider payout confirmation | Reduce seller payable only on authoritative settlement transition | Payout clearing/cash mapping not decided | **Blocked** |
| Refund | Verified provider refund state linked to original capture/order | Full/partial reversal under remaining refundable amount | Fee reversal, tax, shipping and contra-revenue treatment not decided | **Blocked** |
| Manual adjustment | Evidence, reason, scoped permission, second approver | Explicit signed adjustment command; never direct counter edit | Approved adjustment/clearing accounts not decided | **Blocked** |

This table is intentionally conservative. A row marked Blocked must not be exposed as an executable API, worker action, UI action, or payment-provider callback side effect.

## 4. Required state machine shape

Provider and marketplace state machines must be separate but correlated. A suggested provider-funding state vocabulary is:

- PENDING: provider intent exists; no spendable funds.
- CONFIRMED: provider has supplied verified final capture/settlement evidence accepted by the chosen provider integration.
- FAILED: provider confirms the attempt failed; no wallet credit.
- REVERSED: previously confirmed funds were reversed; create a compensating workflow, never mutate a posted journal row.
- DISPUTED: provider reports a dispute/chargeback; apply the approved hold and evidence workflow.

Allowed transitions, terminality, and provider-specific meaning must be reviewed against the selected payment provider before implementation. Do not infer that a generic succeeded webhook always means funds are settled or irrevocable.

For marketplace orders, define a separate reviewed state machine for authorization, reservation, capture, fulfilment, seller payable, payout, cancellation, refund, and dispute. State transitions must be monotonic or explicitly compensating and must retain the source event that caused each transition.

## 5. Atomic command boundary

When a future supported command changes financial state, its single database transaction should contain, as applicable:

1. Tenant/owner-scoped row lock and authoritative state/version check.
2. Idempotency claim scoped to tenant + operation + source identity.
3. Wallet counter mutation guarded by sufficient-funds / non-negative / upper-bound predicates.
4. Immutable wallet-ledger row with source linkage.
5. One balanced journal transaction with deterministic account mapping and immutable source reference.
6. Outbox event with schema version and correlation ID.

Do not call an external payment provider while holding the database transaction open. Use an outbox/inbox pattern: persist intent, dispatch asynchronously, authenticate the callback, deduplicate its provider event ID, then apply the authoritative transition in a new serializable transaction.

The journal API now exposes `postJournalTransactionInTransaction(tx, input)` for a caller-owned Prisma transaction, while `postJournalTransaction(prisma, input)` retains its standalone SERIALIZABLE transaction and retry behavior. A future supported wallet command can therefore include journal posting in the same transaction, provided the outer transaction owns the isolation level and retries the entire operation. This primitive is available but is not yet wired into reservation/release or any deposit, purchase, payout, or refund flow.

## 6. Idempotency and data-model review gates

Before adding payment commands, review these existing constraints together:

- `WalletLedger.referenceId` is globally unique. The current reservation/release services use it as a global command reference and reject an existing reference when account, entry type, amount, or (for releases) source reservation differs. The wallet row is tenant/owner scoped before this check. This prevents cross-account reuse but also means two tenants cannot independently reuse the same reference string. The services do not currently persist a canonical request hash, and descriptive/correlation metadata is not part of the conflict comparison. Before broadening financial commands, decide whether to retain globally unique references or migrate to tenant/operation-scoped idempotency with an explicit compound key and payload-hash conflict detection.
- WalletLedger.reservationReferenceId points to a source ledger reference. Preserve the invariant that the source is a RESERVATION on the same wallet and tenant.
- Provider event IDs need a durable inbox/deduplication record including provider, environment, event type, payload hash, received time, and processing result.
- Journal idempotency currently uses tenant + reference. Define a canonical reference namespace for every lifecycle operation and preserve payload-hash conflict detection.
- Outbox dispatch needs leases, bounded retries, dead-letter handling, and replay tooling; replay must remain idempotent.

Do not alter a unique key or reservation relation in isolation: migration, service predicates, data backfill, and two-tenant PostgreSQL tests must change together.

## 7. Approval questions before implementation

The product/accounting owner and finance reviewer must explicitly decide:

1. Which payment provider(s), payment methods, escrow model, and settlement evidence are supported?
2. Are funds held in a platform-controlled wallet, provider balance, or external escrow? Who legally holds customer funds?
3. What are the chart-of-accounts codes and debit/credit directions for each currency and lifecycle event?
4. When is a buyer charged, when is seller payable recognized, and when is a seller payout considered final?
5. How are tax, shipping, fee refunds, partial refunds, chargebacks, reserves, and negative balances treated?
6. What evidence and approvals are required for opening balances and manual adjustments?
7. What are the exact provider event IDs and state transitions for the selected provider?
8. What reconciliation source and tolerance apply, and who can release an operational hold?

No implementation should guess these answers.

## 8. Acceptance tests required before enabling any lifecycle

- Two-tenant isolation for every command and provider event.
- Identical retry returns the original result; conflicting retry is rejected.
- Duplicate/out-of-order provider events are safely deduplicated.
- Concurrent capture/refund/reservation/payout cannot overdraw or double-settle.
- Every posted journal transaction is balanced, finalized, and linked to its source event.
- Wallet counter = wallet-ledger-derived counter under the approved accounting definition.
- Wallet ledger and journal reconcile by tenant, currency, source reference, and account mapping.
- Partial refunds/releases cannot exceed the original settled/reserved amount.
- Reversal uses compensating entries and preserves the original posting.
- Outbox failure/replay cannot duplicate a financial effect.
- Reconciliation drift alerts and holds; no automatic balance rewrite.
- PAPER-only tests; production credentials and live provider calls remain disabled until explicit approval.

## 9. Release gate

This proposal does not authorize production migrations, deployment, payment-provider configuration, funding, payout, or live trading. PR #32 remains Draft and depends on PR #31. The policy must be reviewed and approved before implementation begins.

## 10. Outbox operations — current implementation boundary

The API outbox worker currently provides:

- Atomic event creation through the caller-owned transaction helper.
- Lease-based claiming with `FOR UPDATE SKIP LOCKED`.
- Lease-owner predicates on publish/failure updates; a stale worker receives `OUTBOX_LEASE_LOST` and cannot overwrite a reclaimed message.
- Bounded exponential retry delay (maximum one hour) and configurable attempt limit.
- `DEAD_LETTER` status after the configured attempt limit.
- Optional event-type allowlist for worker isolation.
- At-least-once delivery semantics. Every downstream handler must be idempotent.

Operational limitations are intentional and must remain visible:

- There is no authenticated dead-letter inspection/replay API, operator UI, or alerting integration. A durable database consumer inbox and a read-only reconciliation report now exist as internal primitives; they are not an operator-facing production control.
- Do not replay by editing database rows manually. A replay workflow must require tenant-aware authorization, an auditable operator identity/reason, a fresh lease, preserved original event identity, and consumer deduplication.
- A dead-letter event must remain retained for investigation; no automatic deletion or silent reset to PENDING.
- A handler side effect may succeed before the worker loses its lease or crashes. Therefore transport delivery cannot promise exactly-once effects; only idempotent consumers can prevent duplicate business effects.
- Lease expiry is a recovery mechanism, not proof that the previous handler stopped. Long-running handlers need bounded execution or lease renewal before they can safely run in production.

Required follow-up before production dispatch:
1. Add authenticated read-only queue health/dead-letter visibility with tenant-safe redaction.
2. Add explicit, audited replay command with approval and idempotency checks; do not expose a generic status mutation.
3. Add metrics for pending age/count, processing leases, retry rate, dead-letter count, publish latency, and lease loss.
4. Apply the durable consumer inbox to every database-only consumer and use provider-level idempotency plus reconciliation for remote side effects.
5. Add tests for expired-lease reclaim, replay authorization, duplicate consumer delivery, and alert thresholds.

Until those controls exist, this worker is an internal integration primitive, not an approved production payment or settlement dispatcher.


## 11. Wallet-to-journal reconciliation implementation boundary

The existing `reconcileWalletJournal` helper is a read-only tenant/owner/account-scoped comparison. It checks the wallet's available and reserved counters against the reservation ledger and the journal's deterministic `WALLET:<walletId>:AVAILABLE` and `WALLET:<walletId>:RESERVED` subaccounts. It reports differences; it does not post, repair, reverse, or mutate financial records.

The account-code convention is currently a technical comparison convention, not an approved complete chart of accounts or a payment/settlement accounting policy. The helper must not be extended to classify reservations as expenses, seller liabilities, captures, payouts, refunds, or settlements without finance-owner approval. Its current integration tests create an explicit journal fixture to verify the comparison and verify tenant/owner scoping.

Before connecting reconciliation to automated operational holds or settlement workflows, approve the chart-of-accounts mapping, treatment of opening balances, and lifecycle event semantics. No provider calls or financial postings are enabled by this helper.


## 12. Sprint 3.12 — verified idempotency boundary

This checkpoint records implementation facts, not an approval of a new financial policy:

- Reservation and release commands require a non-empty reference and perform the tenant/owner/account-scoped wallet lock before checking for an existing ledger reference.
- An identical retry for the implemented command fields returns the current wallet snapshot without creating another ledger row or outbox event.
- A conflicting reuse is rejected with `IDEMPOTENCY_CONFLICT` when account, entry type, amount, or release source reservation differs.
- The database constraint on `WalletLedger.referenceId` is global, not tenant-scoped. A reference collision across tenants therefore cannot create a second command; it is rejected, but independent tenants cannot reuse the same reference string.
- There is no canonical payload hash persisted for wallet commands. Description and correlation ID are not currently part of the idempotency comparison.
- The journal has a separate tenant-scoped unique key `(tenantId, referenceId)` and a stored `payloadHash`; these are not yet unified with wallet command idempotency.
- `postJournalTransactionInTransaction` is available for a future atomic command, but no current wallet lifecycle mutation posts a journal transaction.

No schema or runtime behavior is changed by this checkpoint. Do not weaken the global unique constraint or introduce a compound-key migration until reference namespace, backfill, collision handling, and two-tenant concurrency behavior are reviewed together. Deposit, purchase, fee, shipping, settlement, payout, refund, chargeback, and adjustment commands remain blocked.


## 13. Sprint 3.13 — atomic composition gap (verified)

The current implementation has two useful caller-owned transaction primitives:

- `postJournalTransactionInTransaction(tx, input)` creates and finalizes a balanced journal transaction inside the caller's transaction.
- `enqueueOutboxEvent(tx, input)` writes an outbox event inside the caller's transaction.

At the initial Sprint 3.13 audit checkpoint, the wallet commands had a private transaction boundary. The implementation below now preserves those public wrappers while also exposing caller-owned transaction variants. Both variants keep the wallet counter mutation, ledger append, and reservation outbox enqueue together.

This is a concrete integration gap, not a failed atomicity guarantee for the existing wallet command. Its three existing writes remain in one transaction. Do not work around the gap by invoking `postJournalTransaction` from inside a wallet transaction or by opening a second transaction: that would break the intended all-or-nothing boundary.

Implemented technical composition primitives:

1. `reserveFundsInTransaction(tx, input)` and `releaseFundsInTransaction(tx, input)` now accept a caller-owned Prisma transaction and preserve the existing wallet lock, validations, counter mutation, ledger append, and wallet outbox enqueue.
2. Existing `reserveFunds(prisma, input)` and `releaseFunds(prisma, input)` remain compatibility wrappers that open SERIALIZABLE transactions and delegate to the transaction-client variants.
3. PostgreSQL integration coverage composes wallet reservation, a test-only balanced journal posting, and an additional outbox event in one outer SERIALIZABLE transaction. It asserts both complete rollback and complete commit.
4. A separate integration test exercises partial release through the caller-owned transaction variant.
5. The outer application command remains responsible for SERIALIZABLE isolation and retrying the entire transaction on serialization failure.
6. Test-only account codes prove technical atomicity; they are not an approved chart of accounts. No journal posting has been added to production reserve/release behavior.

No schema, accounting mapping, provider call, payment command, or production lifecycle semantics are changed.


## 14. Sprint 3.14 — bounded serializable transaction retries

- Added `runSerializableTransaction` as the shared wrapper for SERIALIZABLE Prisma transactions.
- It retries the complete transaction callback only for Prisma `P2034` serialization/deadlock conflicts; default is three total attempts with a small linear delay.
- Non-serialization errors pass through immediately. Exhausted retries surface the final Prisma error; configuration is bounded and validated.
- Wallet reserve/release wrappers now delegate to this helper. Caller-owned `reserveFundsInTransaction` and `releaseFundsInTransaction` remain transaction primitives and do not retry independently; an outer composed command must retry its entire transaction using the helper.
- Retried callbacks may execute more than once. They must contain database work only; remote/provider calls, notifications and other non-transactional effects must be represented by an outbox event and handled after commit.
- Unit tests cover retry-on-P2034, no retry for business errors, attempt exhaustion, SERIALIZABLE isolation and invalid retry configuration.
- This is transaction reliability plumbing only. It does not authorize journal account mappings, deposits, purchases, fees, payouts, refunds, chargebacks or provider execution.

## 15. Sprint 3.16 — concurrent partial-release regression coverage

This checkpoint adds PostgreSQL integration coverage only; it does not change wallet behavior or authorize a new financial lifecycle.

- Two simultaneous calls using the same partial-release reference and identical payload must both resolve successfully while producing exactly one release ledger row and one release outbox event.
- Two simultaneous partial releases with distinct references that would cumulatively exceed the original reservation must produce one successful release and one rejected command. The resulting release total must remain within the original reservation, and the wallet reserved counter must match the single committed release.
- The existing concurrent full-release test remains in place.

These tests exercise the wallet row lock, serializable retry wrapper, source-reservation cumulative limit, idempotency, and transactional outbox together. They use isolated PostgreSQL fixtures only. No journal mapping, provider integration, live payment, payout, or production mutation is introduced by this checkpoint. The test suite must pass on the exact branch head before this sprint is considered complete.

## 16. Sprint 3.17 — partial-release transaction composition proof

Adds a PostgreSQL integration proof for the release side of the caller-owned transaction boundary:

- A partial release, balanced test-only journal transaction, and additional outbox event are executed in one SERIALIZABLE transaction.
- A forced failure must roll back the reserved-counter decrement, release ledger row, journal header/entries, and both outbox events.
- A successful retry of the same composition shape must commit the release, journal, and outbox writes together.
- The test uses explicitly named TEST-RELEASE-* journal account codes only; these are not production accounting mappings.

This validates technical atomicity for a composed release command. It does not wire journal posting into the existing production releaseFunds wrapper, approve financial semantics, or enable provider, payout, refund, settlement, or payment execution. A future production command still requires finance-owner approval of the accounting treatment and an authenticated application-level authorization boundary.


## Sprint 3.18 — Read-only reconciliation guarantees

The wallet-to-journal reconciliation integration test now snapshots the wallet row, reservation ledger rows, and journal transaction count before invoking `reconcileWalletJournal`, then proves those records are unchanged after the report is produced. The report remains tenant/owner/account scoped and diagnostic only; the deliberately induced drift fixture is a separate explicit test mutation, not a reconciliation side effect.

The outbox reconciliation integration test now exercises the bounded `since` + `limit` query against controlled PostgreSQL fixtures. It verifies stable ordering for equal timestamps, confirms the exact selected event is reported, and compares the persisted rows before and after both scans. The report continues to expose metadata only and never returns event payloads.

These tests do not authorize journal posting, wallet repair, outbox lease reclamation, replay, or any external financial action.


## Sprint 3.19 — wallet reconciliation tenant/owner isolation

The PostgreSQL integration coverage now creates a real wallet under one tenant and verifies that the reconciliation entry point rejects both:
- the same wallet ID paired with a different existing tenant ID; and
- the same wallet ID and tenant paired with a different owner ID.

The positive control confirms that the correct tenant/owner/account tuple still resolves the wallet. This closes a test-quality gap in the earlier negative case, which used an unknown wallet ID and therefore did not prove isolation against an existing record.

The implementation remains unchanged: `reconcileWalletJournal` resolves the wallet with the complete `(id, tenantId, ownerId)` predicate, then scopes journal balance reads by tenant. No wallet, ledger, journal, or outbox mutation is added; no accounting mapping or payment lifecycle is enabled.


## Sprint 3.20 — outbox reconciliation boundary coverage

The pure reconciliation tests now pin the time-boundary semantics:
- A processing lease expiring exactly at the supplied `now` is not yet classified as expired; expiry is strictly earlier than `now`.
- A pending event exactly at its warning threshold is not overdue; the age must be strictly greater than the configured threshold.
- A zero-second threshold reports an event that is already due, and non-finite thresholds are rejected.

The PostgreSQL integration suite also verifies that the bounded outbox scan rejects zero, negative, fractional, and over-maximum limits, while accepting the configured maximum of 10,000. This is validation coverage only; the scan remains metadata-only and read-only. No worker lease, event status, payload, wallet, journal, or payment behavior is changed.


## Sprint 3.21 — deterministic outbox reconciliation findings

The pure outbox reconciliation function now sorts findings by event ID, finding code, and consumer name before returning the report. This makes report comparisons stable when the same event set is supplied in a different input order or required consumers are configured in a different order.

A unit regression test permutes both event order and consumer configuration order, then asserts complete report equality and the canonical finding sequence. The database query continues to use its existing deterministic `createdAt ASC, id ASC` selection order; this sprint makes the pure report output deterministic independently of that query order.

This is a diagnostic-output change only. It does not mutate outbox events, receipts, leases, wallet balances, ledger entries, journal postings, or payment state. No automatic replay, repair, financial posting, or external side effect is introduced.


## Sprint 3.22 — PostgreSQL canonical finding-order proof

The bounded PostgreSQL outbox reconciliation integration test now supplies multiple required consumers in reverse lexical order and asserts the exact returned finding sequence for multiple events sharing the same creation timestamp. For each event, the report must list the missing published timestamp first, followed by required-consumer findings in canonical consumer-name order; events themselves must follow canonical event-ID order.

Unlike a set-membership or post-sorted assertion, this verifies the actual report sequence returned by the database-backed reconciliation entry point. The existing before/after row comparison remains in place, and the report must continue to omit payload data.

This is integration-test and documentation coverage only. No production behavior, event state, receipt, lease, wallet balance, ledger entry, journal posting, payment state, or external side effect is changed.


## Sprint 3.23 — required consumer receipt reconciliation proof

The PostgreSQL outbox reconciliation integration suite now creates a published event with an actual durable consumer receipt for an explicitly required consumer. It verifies that reconciliation emits no finding for that event when the receipt exists and confirms the persisted receipt remains present.

Together with the existing missing-receipt case, this covers both sides of the required-consumer check against PostgreSQL rather than only testing the pure classifier. The fixture is isolated and cleaned up by the integration suite.

This is test and documentation coverage only. It does not dispatch events, create business effects, mutate wallet or journal state, or authorize external financial actions.


## Sprint 3.24 — duplicate required-consumer configuration

The pure outbox reconciliation classifier now treats the required-consumer list as a set while evaluating each published event. Repeated consumer names in configuration therefore produce one missing-receipt finding rather than duplicate diagnostics. A unit regression test covers duplicate and distinct required consumers and asserts the canonical output.

This is diagnostic correctness hardening only. It does not alter event dispatch, consumer receipt persistence, wallet or journal state, payment behavior, or external effects.


## Sprint 3.25 — PostgreSQL proof for duplicate consumer configuration

The PostgreSQL integration suite now exercises duplicate required-consumer names through the database-backed reconciliation entry point. It asserts that each distinct missing consumer produces exactly one finding even when configuration repeats a consumer name, while a published timestamp remains valid.

This is integration-test and documentation coverage only. It does not mutate event state beyond isolated fixture creation/cleanup, dispatch events, alter receipts, or change wallet, journal, payment, or external-effect behavior.


## Sprint 3.26 — duplicate consumer configuration with existing receipts

Unit and PostgreSQL integration coverage now verify the complementary case: when a required consumer appears multiple times in configuration but its durable receipt exists, reconciliation emits no missing-receipt finding for that consumer. Other distinct consumers without receipts remain individually reported. The database test also verifies the persisted receipt remains present.

This is test and documentation coverage only. No production logic, event dispatch, receipt mutation, wallet/journal state, payment behavior, or external effects are changed.


## Sprint 3.27 — transactional inbox input contract

Unit coverage now verifies the transactional inbox boundary before database work: consumer names are trimmed and constrained to 1–128 characters, blank event IDs are rejected, receipt insertion uses conflict-safe duplicate handling, and an existing receipt prevents the handler from running. Invalid inputs must not touch the receipt table or invoke consumer code.

This is test and documentation coverage only. No production behavior, database schema, event dispatch, wallet/journal state, payment behavior, or external side effect is changed.


## Sprint 3.28 — inbox dead-letter failure boundary

PostgreSQL integration coverage now verifies the inbox-enabled worker's exhausted-attempt path: a consumer transaction failure rolls back its receipt, transitions the event to DEAD_LETTER at the configured attempt limit, clears the lease, and persists only sanitized error details. The test uses synthetic credentials and asserts that neither value survives in the stored error.

This is integration-test and documentation coverage only. No production worker behavior, schema, event dispatch, wallet/journal state, payment behavior, or external side effect is changed.


## Sprint 3.29 — inbox crash recovery after consumer commit

PostgreSQL integration coverage now models a worker crash after the consumer transaction committed its durable inbox receipt but before the outbox acknowledgement. The fixture starts in PROCESSING with an expired lease and an existing receipt. A replacement worker must reclaim the event, skip the consumer handler because the receipt already exists, and acknowledge it as PUBLISHED without duplicating the receipt or database effect.

This verifies the database-only at-least-once recovery boundary. It does not claim exactly-once delivery for remote side effects and does not change production worker behavior, schema, wallet/journal state, payment behavior, or external effects.


## Sprint 3.30 — concurrent outbox worker claim

PostgreSQL integration coverage now holds the first worker inside its transactional inbox handler while a second worker attempts to claim the same eligible event. The second worker must return IDLE while the first lease is active. The test then releases the first worker and verifies a single handler invocation, one durable receipt, one database effect, and one successful publication.

This proves the database claim boundary for two concurrent workers against PostgreSQL. It does not imply exactly-once external effects and introduces no production worker, schema, wallet/journal, payment, or external-side-effect changes.


## Sprint 3.31 — unique outbox lease fencing tokens

Outbox claims now persist a unique per-claim token composed from the worker identity and a fresh UUID. A worker must present that exact token to acknowledge publication or schedule failure. Reusing a worker ID after a lease expires therefore cannot let an earlier, still-running attempt overwrite the newer claim.

PostgreSQL integration coverage expires a live lease while its handler is held, reclaims it with the same worker ID, and proves the stale attempt receives OUTBOX_LEASE_LOST while the replacement claim remains PROCESSING. The replacement then completes publication. This is a database lease-fencing guarantee, not exactly-once delivery for remote effects.


## Sprint 3.32 — single claimant for concurrent expired-lease recovery

PostgreSQL integration coverage creates one PROCESSING event with an expired lease and races two independent claim attempts. Exactly one attempt must receive a claim token; the other must receive no event. The persisted attempt counter advances once, and the stored lease owner must equal the winning claim token with a future lease deadline.

This verifies the expired-lease recovery contention boundary using PostgreSQL row locking. It adds test and documentation coverage only; no production behavior, schema, wallet/journal, payment, or external side effects are changed.
