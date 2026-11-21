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


## Runtime- und Startpfad-Audit

Die Betriebsprüfung auf demselben Finance-Branch bestätigt eine zusätzliche Lücke:

| Komponente | Code vorhanden | Startpfad im API-Paket | Laufender Betrieb belegt |
|---|---:|---|---:|
| API-Server (`src/server.ts`) | Ja | `npm start` / `npm run dev` | Nur als Serverprozess, nicht als Worker-Beleg |
| Agent-Task-Worker (`src/agent-task-worker.ts`) | Ja | `npm run worker` | Nein, Deployment/Prozess nicht belegt |
| Agent-Orchestrator (`src/agent-orchestrator.ts`) | Ja | Kein eigenes Paket-Script in `services/api/package.json` | Nein |
| Outbox-Worker (`src/outbox-worker.ts`) | Ja, Bibliotheksfunktionen | Kein eigenes Paket-Script/CLI-Einstieg in `services/api/package.json` | Nein |
| Outbox-Consumer-Registry | Ja, Dispatch-Abstraktion | Keine gefundene Registry-Instanzierung oder fachliche Registrierung | Nein |

Der API-Server in `src/server.ts` erstellt Prisma und Fastify und startet ausschließlich `buildServer(...)` mit `app.listen`. Er startet weder Outbox-Worker noch Agent-Orchestrator.

Das API-Paket definiert `worker` als Startscript für `agent-task-worker.ts`, aber kein entsprechendes `outbox-worker`-Script. Der Outbox-Worker stellt derzeit Funktionen zum Claim, Ack, Retry und Inbox-Processing bereit; ein dauerhaft laufender Polling-Loop und ein produktiver Handler-Registry-Bootstrap sind im geprüften Startpfad nicht nachgewiesen.

Die API-README grenzt das ausdrücklich ab: Der lokale Produkt-Demo-Start aktiviert weder den separaten Outbox-Worker noch den Agent-Orchestrator; der aktuelle API-Server startet nur Health-/Operations-Routen. Das ist eine Dokumentationsaussage zum vorgesehenen Startpfad und kein Deployment-Nachweis für andere Umgebungen.

### Betriebsrisiko und sichere Reihenfolge

1. Keine Events als „zugestellt“ oder „verarbeitet“ ausweisen, nur weil sie atomar in `OutboxEvent` gespeichert sind.
2. Vor einem Outbox-Worker einen expliziten Prozess-Einstieg mit Shutdown, Poll-Backoff, Health/Readiness, Lease-Konfiguration und eindeutiger Worker-ID definieren.
3. Vor dem Start eine allowlist-basierte Consumer-Konfiguration laden und bei unbekanntem Event/Schema fail-closed bleiben.
4. Zunächst einen reinen DB-Projektions-Consumer in isolierter Umgebung integrieren; externe Effekte und Finanzbuchungen bleiben ausgeschlossen.
5. Laufzeitbelege getrennt erfassen: Prozess/Deployment, Queue-Lag, Claim/Lease, Retry/DLQ, Consumer-Receipt und fachliche Wirkung.


## Event-Klassifikation und Fan-out-Entscheidung

Die Event-Typen wurden nach ihrem tatsächlichen Zweck im geprüften Code eingeordnet. "Nicht fan-outen" bedeutet hier nicht, dass das Ereignis gelöscht werden soll; es bedeutet, dass kein unabhängiger Consumer ohne nachgewiesenen fachlichen Bedarf aktiviert wird.

| Event-Typ | Klasse | Fan-out-Entscheidung | Begründung / Voraussetzung |
|---|---|---|---|
| `agent.task.created` | Task-Lifecycle / Audit | Vorerst kein Consumer | Der Orchestrator liest AgentTask direkt. Zusätzliche Queue-Verbraucher könnten denselben Auftrag doppelt starten. |
| `agent.task.started` | Task-Lifecycle / Telemetrie | Optional später | Erst nach Definition eines konkreten Audit-/Observability-Ziels und Retention. |
| `agent.task.checkpointed` | Task-Lifecycle / Telemetrie | Kein Standard-Fan-out | Checkpoint liegt bereits auf AgentTask; Event-Consumer darf keine zweite Checkpoint-Wahrheit erzeugen. |
| `agent.task.succeeded` | Task-Lifecycle / Audit | Optional später | Geeignet für Benachrichtigung/Projektion, wenn ein fachlicher Empfänger und Datenschutzregeln feststehen. |
| `agent.task.retry_scheduled` | Task-Lifecycle / Telemetrie | Kein Standard-Fan-out | Retry wird bereits über AgentTask.availableAt gesteuert. Kein zweiter Retry-Mechanismus. |
| `agent.task.failed` | Task-Lifecycle / Audit | Optional später | Erst nach Definition von Fehlerklassifikation, Zugriffsschutz und Aufbewahrung. |
| `agent.task.cancelled` | Task-Lifecycle / Audit | Optional später | Kein zusätzlicher Cancel-Consumer ohne konkreten Seiteneffekt. |
| `hidden_treasure.analysis.requested` | Legacy-/Domänen-Signal | Nicht als Worker-Queue verwenden | Die Analyse wird bereits über AgentTask + Agent-Task-Worker abgearbeitet. Das Event ist derzeit redundant für die Ausführung. |
| `wallet.reservation.created` | Finanzielles Domänenereignis | Gesperrt | Nur nach genehmigtem Kontenplan, Buchungsregeln, Idempotenz-/Storno-Konzept und Finance-Owner. |
| `wallet.reservation.released` | Finanzielles Domänenereignis | Gesperrt | Gleiche Finance-Gates; keine automatische Journalbuchung aus dem derzeitigen Payload. |

### Event-Vertrag und Producer-Konsistenz

- `OutboxEvent.schemaVersion` hat Datenbank-Default `1`. Der direkte Producer in `app.ts` lässt das Feld weg; Task-Service und Wallet-Service schreiben über unterschiedliche Pfade. Das funktioniert mit dem aktuellen Default, aber die Event-Erzeugung ist nicht zentral validiert.
- `enqueueOutboxEvent(tx, input)` validiert nichtleere Event-Typen/Aggregate-IDs und positive ganzzahlige Schema-Versionen und schreibt innerhalb der übergebenen Transaktion.
- Der Task-Service verwendet derzeit einen eigenen lokalen `emit`-Helper mit direktem `outboxEvent.create`; die Treasure-Analysis-Route schreibt ebenfalls direkt. Eine spätere Konsolidierung sollte alle Producer über den gemeinsamen Helper führen, ohne Transaktionsgrenzen zu verändern.
- Der Wallet-Payload enthält tenantId, Task-Lifecycle-Payloads nicht. Bei Task-Events ist die Datenbankrelation `AgentTask.tenantId` maßgeblich; bei Wallet-Events `WalletAccount.tenantId`.
- Keine dieser Event-Klassen besitzt aktuell einen bestätigten produktiven Consumer-Startpfad. Diese Tabelle ist eine Architekturentscheidung für die nächste Umsetzung, keine Aktivierungsfreigabe.

### Empfohlener erster Consumer

Keiner der bestehenden Event-Typen ist bereits ein sicherer erster Fan-out-Kandidat:
- Task-Events haben bereits einen primären direkten Task-Worker-Pfad oder würden zunächst nur Telemetrie duplizieren.
- Wallet-Events sind finanzkritisch und bleiben gesperrt.
- Treasure-Analysis ist für die Ausführung redundant zum AgentTask.

Der erste Consumer sollte daher erst nach Benennung eines echten Projektion-/Audit-Ziels samt Eigentümer eingeführt werden. Ein künstlicher "logging consumer" ist kein Ersatz für einen fachlichen Zweck und erzeugt nur scheinbare Betriebsaktivität.
