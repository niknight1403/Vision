# Outbox Operations and Recovery

## Delivery contract

The outbox provides at-least-once delivery, not exactly-once delivery. A handler can complete its external side effect and lose its lease before the database records PUBLISHED. Every consumer must therefore deduplicate using the immutable event ID (and, where appropriate, aggregate ID plus event type) before applying a side effect.

## State handling

- `PENDING`: eligible when `availableAt <= now()`.
- `PROCESSING`: owned by `lockedBy` until `leaseUntil`; an expired lease can be reclaimed.
- `PUBLISHED`: terminal success; do not replay automatically.
- `DEAD_LETTER`: retry budget exhausted; preserve payload and diagnostic for investigation.

The worker uses bounded exponential backoff (default 5 seconds, capped at one hour) and a configurable attempt limit (default 8). Lease loss is surfaced as `OUTBOX_LEASE_LOST`; a stale worker must not overwrite the current owner's state.

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
