# Outbox Operations and Recovery

## Delivery contract

The outbox provides at-least-once delivery, not exactly-once delivery. A handler can complete its external side effect and lose its lease before the database records PUBLISHED. Every consumer must therefore deduplicate using the immutable event ID (and, where appropriate, aggregate ID plus event type) before applying a side effect.

## State handling

- `PENDING`: eligible when `availableAt <= now()`.
- `PROCESSING`: owned by `lockedBy` until `leaseUntil`; an expired lease or missing `leaseUntil` can be reclaimed. A worker may acknowledge success or failure only while its lease is still valid.
- `PUBLISHED`: terminal success; do not replay automatically.
- `DEAD_LETTER`: retry budget exhausted; preserve payload and diagnostic for investigation.

The worker uses bounded exponential backoff (default 5 seconds, capped at one hour) and a configurable attempt limit (default 8). The claim transaction enforces the same limit for both due `PENDING` events and expired `PROCESSING` leases: an event whose attempt budget was exhausted by repeated worker crashes is moved to `DEAD_LETTER` before another handler invocation. Lease loss is surfaced as `OUTBOX_LEASE_LOST`; a stale worker must not overwrite the current owner's state.

## Consumer schema compatibility

The API now provides an opt-in `OutboxConsumerRegistry` that dispatches only an exact registered pair of event type and schema version. It deliberately has no fallback to the latest or nearest version: an unknown event or version fails before the consumer handler runs, so incompatible payloads cannot silently reach a side effect. Register each supported version explicitly and keep old handlers registered while old events may still be pending or replayed.

The API also provides `processOutboxEventInTransaction`, backed by a durable `OutboxConsumerReceipt` unique on `(consumerName, eventId)`. Call it inside the same Prisma transaction as the consumer's database writes. The receipt and those writes commit or roll back together; a repeated delivery for that consumer returns `DUPLICATE` without running the handler. The PostgreSQL integration tests cover repeat delivery, independent consumers, and rollback/retry.

The outbox worker exposes `processOneOutboxMessageWithInbox` for database-only consumers. It claims the event, runs the inbox helper in a Prisma transaction, and acknowledges the outbox row only after that transaction commits. If the process stops after the receipt commit but before the outbox acknowledgement, a later delivery observes the receipt, skips the handler, and acknowledges the event. Integration tests cover this crash-window redelivery path. The helper must not be used to wrap non-transactional remote calls.

This inbox protects transactional database effects only. It does not make remote HTTP/payment/provider side effects exactly-once, and it is not automatically wired into every `processOneOutboxMessage` handler. Financial consumers must explicitly use the transactional helper; remote effects still require downstream idempotency keyed by immutable event ID, reconciliation, and a carefully designed dispatch boundary.

## Read-only reconciliation

`reconcileOutbox(prisma, options)` returns a bounded, metadata-only report. It does not update events, reclaim leases, replay dead letters, or create missing receipts. The query deliberately excludes payloads. Use a bounded `limit` (default 1,000; maximum 10,000) and optionally a `since` timestamp when reviewing a large event history.

The report checks:
- PROCESSING rows with incomplete lease metadata and expired leases;
- non-PROCESSING rows that still carry a worker lock or lease;
- PUBLISHED rows without `publishedAt`;
- PUBLISHED rows missing a receipt for a consumer explicitly listed in `expectedConsumers[eventType]`;
- DEAD_LETTER rows and overdue PENDING rows.

The required-consumer map is an explicit operational contract supplied by the caller. An event type absent from that map has no receipt completeness assertion; the tool does not guess which consumer should receive an event. **The current dispatcher supports one terminal delivery/consumer per event type and schema version.** The reconciliation function rejects configurations listing more than one independent consumer for an event type (OUTBOX_MULTI_CONSUMER_FANOUT_UNSUPPORTED): the event has one global PUBLISHED state, so claiming that multiple independent consumers are complete would be false until per-consumer delivery rows or equivalent fan-out state exist. A missing receipt is reported as a discrepancy, not repaired automatically. A PROCESSING event with an existing receipt may represent the crash window after consumer commit and before outbox acknowledgement; the inbox-aware worker safely handles redelivery.

The report contains event IDs, event types, finding codes, severities and counts only. It is an investigation aid, not proof of downstream provider settlement or external side-effect completion. Remote systems still require their own idempotency and reconciliation.

## Required operational signals

Export counters and gauges from the worker/DB observer (do not log payloads):

- pending count and oldest pending age;
- processing count and expired lease count;
- published count/rate;
- retry count/rate by event type and bounded error class;
- dead-letter count and oldest dead-letter age;
- handler duration and claim-to-publish duration;
- lease-lost count.

Alert on any dead-letter growth, sustained oldest-pending age above the event's delivery SLO, or expired leases persisting across multiple poll intervals. Define per-event SLOs before enabling production consumers.

## Dead-letter investigation and recovery

1. Identify the event by ID, event type, aggregate ID, attempts, timestamps and redacted `lastError`. Never dump payloads or credentials into tickets/logs.
2. Confirm the consumer's idempotency record and inspect downstream state before retrying. Determine whether the external side effect already happened.
3. Classify the failure (transient dependency, invalid schema/payload, revoked authorization, permanent business rejection, or consumer bug).
4. Correct the underlying cause and add a regression test.
5. Replay only through a separately reviewed, authenticated operator workflow. The current OutboxEvent model has no explicit tenantId; do not expose tenant-scoped replay until tenant ownership can be resolved by a trusted event-type-specific aggregate lookup or an explicit, backfilled tenant key. Fail closed when ownership is ambiguous.
6. The replay command must be idempotent and transactional: authenticate the actor; enforce least-privilege operator authorization; require a non-empty reason and a unique replay-request/idempotency key; capture the pre-replay status, attempts, lastError, event ID, actor, timestamp and correlation ID in an append-only replay audit record; then compare-and-set the exact event ID from DEAD_LETTER with no active lock/lease to PENDING. The audit record and state transition must commit in the same database transaction. A stale or repeated request must not requeue the event twice.
7. Preserve the original event ID, payload, event type, schema version and aggregate/correlation identity so consumer/provider deduplication remains effective. Reset the active attempts counter to zero only as part of the approved replay transaction, because the normal claim path will otherwise immediately dead-letter the event again. Preserve the exhausted attempt count and prior diagnostic in the immutable replay audit record; do not erase incident history.
8. Require independent second-person approval for financial, payment, settlement or other irreversible remote side effects. The requester must not approve their own replay. Validate that the exact consumer/schema version remains registered and compatible before requeueing.
9. Verify the consumer deduplicates the event and reconcile downstream state before closing the incident. For remote effects, confirm provider idempotency behavior using the original event ID before allowing replay.

## Current implementation boundary

This PR does not add an operator replay endpoint, dashboard, metrics exporter, or automatic DEAD_LETTER replay. The replay contract above is a design gate, not an implemented capability. In particular, the schema still lacks an append-only replay audit model and an explicit tenant ownership field/resolver for every event type. Do not manually flip rows to PENDING in production. Until the authenticated, tenant-safe, audited workflow is implemented and reviewed, DEAD_LETTER records remain retained for investigation and require controlled database-owner intervention under the deployment's incident/change process.

## Security

- Persist only sanitized error summaries; do not persist request headers, raw provider responses, secrets, or full URLs with credentials.
- Keep event payloads out of routine logs and metrics labels.
- Restrict database access and any future replay permission to least-privilege operators.
- Keep consumers idempotent and validate event schema versions before side effects.

## Acceptance tests before production enablement

- Duplicate delivery after side effect / before publish acknowledgement does not duplicate the effect.
- Expired lease can be reclaimed; stale owner cannot publish or fail the new owner's lease.
- Retry delay and maximum attempts are bounded.
- DEAD_LETTER transition is observable and cannot be replayed without an audited authorization path.
- Metrics and alerts are exercised with synthetic test events.
- Event schema compatibility is verified for every registered consumer.
