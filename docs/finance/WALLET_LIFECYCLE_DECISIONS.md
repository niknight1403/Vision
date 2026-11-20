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

The current journal postJournalTransaction helper can be used inside a Prisma transaction only after its API is refactored to accept a transaction client. It currently owns its own PrismaClient transaction; nesting that helper inside a wallet transaction would break the required atomic boundary. This refactor is a prerequisite, not an optional optimization.

## 6. Idempotency and data-model review gates

Before adding payment commands, review these existing constraints together:

- WalletLedger.referenceId is globally unique. Decide whether it represents a globally unique command ID or should become tenant/operation-scoped with an explicit compound unique constraint.
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
