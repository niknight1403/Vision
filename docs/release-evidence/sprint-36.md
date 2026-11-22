# Sprint 36 — Outbox-/Worker-Betrieb

**Nachweis:** `services/api/src/outbox-worker.ts`, `src/outbox-operations.integration.test.ts`, `prisma/migrations/20261122033000_outbox_replay_tracking/migration.sql`, `docs/monitoring-alerting.md`.

## Umgesetzt

- **Lease-Reaper:** `reapExpiredLeases({ limit })` gibt abgelaufene `PROCESSING`-Leases begrenzt (1–1000 pro Lauf) in die Queue zurück, leert `lockedBy`/`leaseUntil` und setzt `lastError = "LEASE_EXPIRED"`. Vorher wurden abgelaufene Leases nur implizit beim nächsten Claim übernommen; ein abgestürzter Worker war unsichtbar.
- **Statuszähler:** `outboxStatusCounts()` liefert `PENDING`/`PROCESSING`/`PUBLISHED`/`DEAD_LETTER` als Gauge für Monitoring und Alerting.
- **Replay-Schutz:** neue Spalte `OutboxEvent.replayCount` (additive Migration, Default 0) plus `replayDeadLetter(id, { maxReplays })`. Nur ein Event, das aktuell `DEAD_LETTER` ist und dessen `replayCount` unter dem Limit liegt, wird erneut eingereiht; Versuche werden zurückgesetzt. Ein zweiter Aufruf liefert `NOT_DEAD_LETTER` bzw. `REPLAY_LIMIT_REACHED`, ein unbekanntes Event `OUTBOX_EVENT_NOT_FOUND`.
- **Redaktion belegt:** `lastError` wird weiterhin redigiert; der Integrationstest prüft, dass weder Token noch Host im gespeicherten Fehler stehen.

## Checks

`npm run test:db` gegen die lokale PostgreSQL-Instanz → **5 Integrationsdateien, 29 Integrationstests, 0 skipped**. Die neuen sieben Tests decken ab: abgelaufene Lease wird zurückgegeben und eine lebende nicht angefasst, ungültiges Reap-Limit, Statuszählung, Retry mit redigiertem Fehler bis `DEAD_LETTER`, Lease-Fencing (ein während des Handlers übernommener Lease führt zu `OUTBOX_LEASE_LOST` und die Zeile bleibt beim neuen Besitzer), Replay genau einmal, Replay-Limit und Replay eines lebenden Events.

`npm run typecheck` grün, `npm test` 106 API-Unit- und 43 Core-Tests grün.

**Grenze:** Der Reaper ist eine Funktion, kein laufender Scheduler; ein Betriebsprozess muss ihn periodisch aufrufen. Ein echter Multi-Prozess-Crash-Test mit mehreren Workern unter Last steht aus.
