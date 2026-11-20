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

The wallet commands have a different boundary today:

- `reserveFunds(prisma, input)` opens and owns its SERIALIZABLE transaction.
- `releaseFunds(prisma, input)` opens and owns its SERIALIZABLE transaction.
- Both commands atomically mutate the wallet counter, append the wallet ledger row, and enqueue their reservation event within that private transaction.
- Neither accepts a caller-owned `Prisma.TransactionClient`; therefore a caller cannot currently compose either wallet mutation with journal posting and a further outbox event in one outer transaction without nesting transactions.

This is a concrete integration gap, not a failed atomicity guarantee for the existing wallet command. Its three existing writes remain in one transaction. Do not work around the gap by invoking `postJournalTransaction` from inside a wallet transaction or by opening a second transaction: that would break the intended all-or-nothing boundary.

Implemented technical composition primitives:

1. `reserveFundsInTransaction(tx, input)` and `releaseFundsInTransaction(tx, input)` now accept a caller-owned Prisma transaction and preserve the existing wallet lock, validations, counter mutation, ledger append, and wallet outbox enqueue.
2. Existing `reserveFunds(prisma, input)` and `releaseFunds(prisma, input)` remain compatibility wrappers that open SERIALIZABLE transactions and delegate to the transaction-client variants.
3. PostgreSQL integration coverage composes wallet reservation, a test-only balanced journal posting, and an additional outbox event in one outer SERIALIZABLE transaction. It asserts both complete rollback and complete commit.
4. A separate integration test exercises partial release through the caller-owned transaction variant.
5. The outer application command remains responsible for SERIALIZABLE isolation and retrying the entire transaction on serialization failure.
6. Test-only account codes prove technical atomicity; they are not an approved chart of accounts. No journal posting has been added to production reserve/release behavior.

No schema, accounting mapping, provider call, payment command, or production lifecycle semantics are changed.
