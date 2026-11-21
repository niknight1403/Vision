# Outbox consumer fan-out — architecture proposal

Status: design only. This document does not change runtime dispatch, database schema, migrations, or replay behavior.

## 1. Current boundary

The current dispatcher claims one `OutboxEvent` and gives it one global terminal state (`PUBLISHED` or `DEAD_LETTER`). `OutboxConsumerReceipt` provides a per-consumer idempotency receipt for transactional database handlers, but it does not provide an independent lease, retry schedule, attempt counter, or dead-letter lifecycle per consumer.

Therefore multiple receipts must not be interpreted as proof that the current dispatcher supports reliable fan-out. Keep the current multi-consumer reconciliation guard until the delivery model is implemented.

## 2. Target model

Introduce one durable delivery row per (event, consumer):

```text
OutboxEvent 1 ─── N OutboxDelivery N ─── 1 ConsumerDefinition
                         │
                         └── 1 ─── N OutboxDeliveryAttempt
```

### OutboxDelivery

Proposed fields:

- `id` primary key
- `eventId` FK to OutboxEvent, delete restricted
- `consumerName` stable, bounded identifier
- `status`: PENDING | PROCESSING | DELIVERED | DEAD_LETTER
- `attempts`, `maxAttempts` (or a versioned policy reference)
- `availableAt`, `leaseUntil`, `lockedBy`
- `deliveredAt`, `lastError`
- `createdAt`, `updatedAt`
- unique constraint on (`eventId`, `consumerName`)
- claim indexes on (`status`, `availableAt`) and `leaseUntil`

The delivery row, not the parent event, owns retry and lease state. A worker partition claims only deliveries for its configured consumer(s). Every acknowledgement is fenced by delivery id, PROCESSING status, worker id, and a still-valid lease.

### ConsumerDefinition

A versioned registry/configuration should define:

- stable consumer name and enabled state
- accepted event types and schema versions
- retry policy / maximum attempts
- owner team and operational contact
- whether the handler is database-transactional or external
- rollout state (disabled, shadow, active, draining)

Do not let arbitrary event payloads choose a consumer or handler. Fan-out recipients must come from trusted, reviewed configuration.

### Attempt history

Add append-only `OutboxDeliveryAttempt` records for claim, success, failure, lease expiry, dead-letter transition, and operator replay. Store timestamps, attempt number, worker identity, result code, and sanitized error metadata. Never store credentials or full sensitive payloads in logs.

## 3. Event creation and delivery materialization

When a producer creates an event, determine its required consumers from trusted event-type configuration and insert the event plus all initial delivery rows in the same database transaction.

If no consumer is configured, fail closed or route to an explicitly configured quarantine consumer; do not silently mark the event published.

The recipient set is snapshotted at event creation. Changing configuration later must not silently add or remove recipients for already-created events. Any explicit recipient migration needs an audited operator action.

## 4. Processing and idempotency

For database-only consumers, run the business effect and transition of the delivery to DELIVERED in one PostgreSQL transaction. The unique (eventId, consumerName) delivery row is the durable inbox identity; if a separate receipt table remains, it must not be the sole source of retry state.

For external effects, PostgreSQL cannot atomically commit the provider action. Require provider-level idempotency keys derived from stable event and consumer identity, persist the provider reference, and reconcile ambiguous outcomes before retrying.

At-least-once delivery remains the contract. Exactly-once external side effects must not be claimed.

## 5. Parent event status

Do not let one consumer's success mark all consumers delivered. During migration, retain the legacy event status only as a compatibility/summary field:

- PENDING while required deliveries are pending or processing
- PUBLISHED only when every required delivery is DELIVERED
- DEAD_LETTER when at least one required delivery is DEAD_LETTER (with the specific failed consumer visible in delivery rows)

Longer term, consider deriving aggregate status from deliveries rather than maintaining two independently mutable state machines. Any aggregate update must be transactionally consistent and idempotent.

## 6. Dead letters and replay

No automatic replay. A replay operation must:

1. authenticate the operator and enforce tenant-scoped role permissions;
2. require a reason and explicit confirmation;
3. use compare-and-set against the expected delivery status/version;
4. append an immutable audit record and attempt-history entry;
5. preserve prior attempt history and increment a replay generation;
6. reset only the selected delivery's active retry state;
7. retain the same event and consumer idempotency identity;
8. check whether an external provider already completed the side effect before resending.

Replay must never delete receipts, rewrite event payloads, or reset another consumer's delivery. High-impact financial consumers should require a second approver.

## 7. Tenant and data boundaries

The shared event catalog and tenant-owned business effects must remain distinct. Every tenant-scoped consumer must derive tenant identity from trusted persisted event metadata and validate membership/authorization at the processing boundary. Never trust a tenant id supplied only inside an unvalidated payload.

The delivery table should carry tenantId only if the event model establishes a non-null, authoritative tenant boundary. Shared/global events need an explicit global scope rather than a fabricated tenant id. Review retention, access control, and RLS/application filtering before exposing delivery diagnostics.

## 8. Expand-and-contract rollout

1. **Inventory:** classify every event type, producer, consumer, schema version, side effect, and tenant boundary.
2. **Expand:** add delivery/config/attempt tables and indexes without changing the existing worker.
3. **Backfill:** create deliveries only from an explicit reviewed event-type-to-consumer mapping. Quarantine ambiguous historical events; never infer recipients from receipt presence alone.
4. **Shadow:** materialize and reconcile delivery rows without invoking handlers. Compare expected recipients and legacy receipts.
5. **Dual-read validation:** report per-consumer lag, expired leases, attempts, missing deliveries, duplicate receipts, and parent/child status disagreement.
6. **Controlled activation:** enable one non-financial idempotent consumer at a time, with feature flag and rollback switch.
7. **Cutover:** move each event type to delivery-level workers only after replay, crash, lease, duplicate, schema-compatibility, and tenant-isolation tests pass.
8. **Contract:** remove the legacy global dispatcher/status only after all producers and consumers have migrated and operational evidence is complete.

## 9. Required test matrix

- two consumers receive the same event independently;
- one consumer succeeds while another retries or dead-letters;
- concurrent workers cannot claim the same consumer delivery;
- expired and NULL leases are reclaimable, and stale acknowledgements are fenced;
- max-attempt enforcement applies to both PENDING and expired PROCESSING deliveries;
- event-type and consumer partitions cannot mutate unrelated deliveries;
- transaction rollback removes business effects and delivery acknowledgement together;
- duplicate delivery is harmless for database and provider-idempotent consumers;
- unknown schema versions and unknown consumers fail closed;
- recipient configuration changes do not mutate existing recipient snapshots;
- tenant A cannot inspect, replay, or process tenant B's private delivery;
- replay uses compare-and-set and preserves immutable history;
- parent aggregate status is correct under concurrent consumer completion.

## 10. Acceptance gates

No production migration or dispatch cutover until:
- event/consumer inventory and owner sign-off are complete;
- tenant and global-event semantics are explicit;
- all migration and rollback scripts are reviewed;
- PostgreSQL integration tests cover the matrix above;
- operational dashboards and alert thresholds exist;
- replay authorization and audit design are implemented;
- non-financial canary proves end-to-end delivery;
- finance/accounting owners approve any financial consumer mappings.

Until then, the existing single-consumer guard remains mandatory. This is a design proposal, not an implementation or deployment claim.
