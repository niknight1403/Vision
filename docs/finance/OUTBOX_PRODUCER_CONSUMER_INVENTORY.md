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


## Erweiterter Audit: Agent-Task-Produzenten

Zusätzliche Treffer der GitHub-Code-Suche (Default-Branch-Index; Quellpfade anschließend auf dem Finance-Branch geprüft):

| Event type | Producer | Transaktion | Payload / tenant context |
|---|---|---|---|
| `agent.task.created` | `createAgentTask` in `services/api/src/agent-task-service.ts` | AgentTask-Erstellung + Event in derselben Prisma-Transaktion | taskId, taskType, ownerId; tenantId fehlt im Event-Payload |
| `agent.task.started` | `claimAgentTask` | Claim/Statuswechsel + Event in derselben Prisma-Transaktion | taskId, workerId, attempt; tenantId fehlt im Event-Payload |
| `agent.task.checkpointed` | `saveTaskCheckpoint` | Checkpoint-Update + Event in derselben Prisma-Transaktion | taskId; tenantId fehlt im Event-Payload |
| `agent.task.succeeded` | `completeAgentTask` | Abschluss + Event in derselben Prisma-Transaktion | taskId; tenantId fehlt im Event-Payload |
| `agent.task.retry_scheduled` | `failAgentTask`, außerdem Lease-Recovery | Task-Update + Event in derselben Transaktion | taskId, error, attempt, availableAt; tenantId fehlt im Event-Payload |
| `agent.task.failed` | `failAgentTask`, außerdem Lease-Recovery | Task-Update + Event in derselben Transaktion | taskId, error, attempt, availableAt; tenantId fehlt im Event-Payload |
| `agent.task.cancelled` | `cancelAgentTask` | Abbruch + Event in derselben Prisma-Transaktion | taskId; tenantId fehlt im Event-Payload |
| `hidden_treasure.analysis.requested` | direkte Erstellung in `services/api/src/app.ts` | AgentTask-Erstellung + Event in derselben Prisma-Transaktion | taskId, taskType; tenantId fehlt im Event-Payload |

Die acht Task-Event-Typen oben sind aus dem geprüften Service-Code abgeleitet; `retry_scheduled` und `failed` haben zwei Erzeugungspfade. Der direkte Treasure-Analysis-Endpunkt verwendet aktuell einen eigenen Event-Schreibpfad statt `enqueueOutboxEvent`.

### Multi-Tenant-Befund

Die Task-Events tragen die Task-ID als Aggregate-ID und können über die AgentTask-Tabelle einem Tenant zugeordnet werden. Der Event-Payload selbst enthält tenantId jedoch nicht. Für spätere fan-out-Zustellung darf die Tenant-Zuordnung daher nicht aus frei veränderbarem Payload allein abgeleitet werden. Die Recipient-Auflösung muss die referenzierte AgentTask serverseitig laden und die Tenant-Zugehörigkeit aus der autoritativen Datenbankzeile übernehmen. Die direkte Treasure-Analysis-Erzeugung setzt tenantId am AgentTask, lässt es aber im Outbox-Payload weg.

### Consumer- und Laufzeitstatus

Die Code-Suche fand keine belastbare produktive Registrierung über `OutboxConsumerRegistry.register` und keine sichtbare Instanzierung der Registry. Im geprüften Quellumfang sind deshalb keine konkreten fachlichen Event-Consumer bestätigt. `processOneOutboxMessage` und der Inbox-Helper sind generische Infrastruktur; das ist kein Beleg für einen laufenden Event-Dispatcher. Der Agent-Task-Worker verarbeitet AgentTask-Zeilen direkt und ist nicht automatisch ein Consumer dieser Outbox-Events.

### Konsequenz vor Fan-out

- Für jeden Event-Typ einen Owner und Zweck festlegen.
- Tenant-ID bei Recipient-Erzeugung aus AgentTask bzw. WalletAccount laden, nicht ungeprüft aus Payload übernehmen.
- Für Task-Lifecycle-Events prüfen, ob sie überhaupt Fan-out benötigen; viele sind Audit-/Telemetry-Signale und können ohne Consumer bleiben.
- `hidden_treasure.analysis.requested` und AgentTask-Queueing nicht doppelt auslösen: vorhandener Worker pollt AgentTask-Status direkt.
- Erst einen nichtfinanziellen, explizit aktivierten Consumer mit DB-only Effekt wählen und per Shadow-Mode testen.
