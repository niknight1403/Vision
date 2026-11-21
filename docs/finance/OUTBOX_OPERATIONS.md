# Outbox Operations and Recovery

## Delivery contract

The outbox provides at-least-once delivery, not exactly-once delivery. A handler can complete its external side effect and lose its lease before the database records PUBLISHED. Every consumer must therefore deduplicate using the immutable event ID (and, where appropriate, aggregate ID plus event type) before applying a side effect.

## State handling

- `PENDING`: eligible when `availableAt <= now()`.
- `PROCESSING`: owned by `lockedBy` until `leaseUntil`; an expired lease can be reclaimed.
- `PUBLISHED`: terminal success; do not replay automatically.
- `DEAD_LETTER`: retry budget exhausted; preserve payload and diagnostic for investigation.

The worker uses bounded exponential backoff (default 5 seconds, capped at one hour) and a configurable attempt limit (default 8). Lease loss is surfaced as `OUTBOX_LEASE_LOST`; a stale worker must not overwrite the current owner's state.

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

The required-consumer map is an explicit operational contract supplied by the caller. An event type absent from that map has no receipt completeness assertion; the tool does not guess which consumers should receive an event. A missing receipt is reported as a discrepancy, not repaired automatically. A PROCESSING event with an existing receipt may represent the crash window after consumer commit and before outbox acknowledgement; the inbox-aware worker safely handles redelivery.

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
5. Replay only through a separately reviewed, authenticated operator workflow that records actor, reason, event ID, prior state, replay time and correlation ID. Requeue must use compare-and-set on the exact event ID and expected `DEAD_LETTER` state; preserve the original event ID and payload.
6. Verify the consumer deduplicates the event and reconcile downstream state before closing the incident.

## Current implementation boundary

This PR does not add an operator replay endpoint, dashboard, metrics exporter, or automatic DEAD_LETTER replay. Do not manually flip rows to PENDING in production. Until an audited operator workflow exists, DEAD_LETTER records require controlled database-owner intervention under the deployment's incident/change process.

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


## Graceful outbox worker shutdown

`runOutboxWorker` is a polling/drain loop controlled by an `AbortSignal`. Once the signal is aborted, the runner stops starting new claims. If a handler is already running, the runner awaits the normal `processOneOutboxMessage` path before returning; successful work is acknowledged, and failed work follows the configured retry/dead-letter policy. The runner returns aggregate published/retried/dead-lettered counts for the lifetime of that run.

This is graceful draining, not forced cancellation. It does not abort arbitrary handler code, and callers must allow enough process termination grace for the active handler and its database acknowledgement to finish. If the process is forcibly killed, lease expiry and at-least-once redelivery remain the recovery mechanism. External side effects still require downstream idempotency.
