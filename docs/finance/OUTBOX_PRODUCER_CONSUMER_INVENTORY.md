# Outbox producer and consumer inventory (verified snapshot)

Audit basis: finance branch `finance/sprint-3-double-entry-ledger`, reviewed 2026-11-21. This is a source-code snapshot, not a promise that no other branches or future producers exist.

## Verified producer path

The only producer path identified in the reviewed finance branch is `enqueueOutboxEvent(tx, input)` in `services/api/src/outbox-service.ts`. It inserts one `OutboxEvent` using the caller's transaction. It currently accepts event type, aggregate id, optional correlation id, schema version, payload, and optional availability time. It does not resolve a recipient set or create delivery rows.

The reviewed wallet service calls it in the same transaction as the wallet ledger mutation:

| Event type | Producer | Aggregate | Payload scope | Verified downstream consumer |
|---|---|---|---|---|
| `wallet.reservation.created` | `reserveFundsInTransaction` | Wallet account ID | tenantId, accountId, ledgerEntryId, referenceId, amountCents, currency, ledger event type | Not identified in reviewed source |
| `wallet.reservation.released` | `releaseFundsInTransaction` | Wallet account ID | tenantId, accountId, ledgerEntryId, referenceId, reservationReferenceId, amountCents, currency, ledger event type | Not identified in reviewed source |

Both producer calls are transactionally coupled to the corresponding wallet ledger entry. The payload carries tenantId, but the event schema itself has no tenantId column. Any future delivery materializer must validate the payload against the authoritative WalletAccount / ledger row rather than treating arbitrary JSON as trusted authorization context.

## Consumer infrastructure found

- `OutboxConsumerRegistry` resolves handlers by exact event type and schema version.
- `processOutboxEventInTransaction` writes a unique (consumerName, eventId) receipt and invokes a database-only handler in the caller's transaction.
- The single-event worker still claims and acknowledges the parent OutboxEvent. It has one lease, retry counter and terminal status shared by all handlers.
- The inbox helper is infrastructure, not proof that a production consumer is registered or actively running.

No verified production handler registration or worker deployment for the two wallet event types was found in the inspected source paths. Do not infer a journal consumer merely because journal tables/services exist.

## Journal boundary

The reviewed `journal-service.ts` contains no direct outbox enqueue reference in the inspected file. The finance implementation therefore does not yet demonstrate a wallet-event-to-journal posting consumer. Wallet-to-journal mapping, chart of accounts, opening balances, posting/reversal policy and reconciliation repair semantics remain unresolved domain decisions.

Do not create a financial consumer or delivery mapping until those decisions are approved by the finance/accounting owner.

## Safe next steps

1. Search all repository branches and application entry points for `enqueueOutboxEvent`, `OutboxConsumerRegistry.register`, `processOneOutboxMessage`, and event-type literals before treating this as a complete repository-wide inventory.
2. Assign an owner and purpose to each confirmed consumer; distinguish database projections from external side effects.
3. Add a trusted, versioned event-type-to-consumer configuration with explicit activation state.
4. For initial fan-out, select a non-financial consumer with idempotent database-only effects; prove delivery in shadow mode before enabling it.
5. Keep financial event types quarantined until accounting semantics and dual-control approval exist.

## Explicit non-claims

This audit does not establish that a consumer is deployed, that events are being processed end-to-end, or that any financial journal posting occurs. No schema or runtime code was changed by this inventory.
