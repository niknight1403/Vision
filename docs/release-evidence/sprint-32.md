# Sprint 32 — PostgreSQL-Integrationsnachweis

**Nachweis:** `scripts/local-postgres.sh`, `services/api/package.json` (`test:db`), `services/api/src/app.ts`, `services/api/src/agent-task-service.test.ts`, `docs/database-invariants-runbook.md`.

## Zwei echte Fehler gefunden und behoben

1. **Die DB-Suite lief nie.** `test:db` übergab den Literal-Glob `'src/**/*.integration.test.ts'` an vitest. Vitest behandelt positionale Argumente als Substring-Filter, nicht als Glob, also endete der Lauf mit „No test files found“ (Exit 1). Der Filter ist jetzt `integration.test`; das Gate `verify-db-integration.mjs` prüft weiterhin, dass alle drei Integrationsdateien tatsächlich ausgeführt und nicht übersprungen wurden.
2. **Idempotenz-Konflikt auf der Treasure-Analyse-Route.** `POST /v1/deals/:dealId/treasure-analysis` berechnete den `inputHash` über `JSON.stringify(input)` in Einfügereihenfolge, während `createAgentTask` den Input kanonisch (sortierte Schlüssel) hasht. Jede Wiederholung mit demselben Idempotency-Key antwortete deshalb mit `409 TREASURE_ANALYSIS_IDEMPOTENCY_CONFLICT` statt `202` mit derselben Task-ID. Die Route nutzt jetzt `hashTaskInput` aus dem Task-Service; drei neue Unit-Tests sichern Reihenfolge-Unabhängigkeit, Wertbindung und die Ablehnung von Nicht-Objekten.

## Ausgeführter Nachweis

- `scripts/local-postgres.sh` initialisiert ein eigenes Cluster (Debian 12, PostgreSQL 15.20), startet es auf `127.0.0.1` und legt `autonomagent_test` an. Aus einem frischen Datenverzeichnis verifiziert, inklusive Passwortsetzung über den lokalen Socket statt über die Prozessliste.
- `npx prisma migrate deploy` → alle acht Migrationen angewendet.
- `npm run test:db --workspace @autonomagent/api` → **PostgreSQL integration gate passed: 3 integration files, 20 integration test(s) executed, 24 test(s) total with 0 skipped** (App-/RBAC-Routen, Agent-Task-Leases/Concurrency, Wallet-Reservierungen).
- `npm test` → 99 API-Unit-Tests (vorher 96) und 43 Trading-Core-Tests grün. `npm run typecheck` grün.

**Grenze:** Der Nachweis gilt für ein lokales Wegwerf-Cluster mit PostgreSQL 15. Ein Produktions-/Staging-Cluster, ein Restore-Drill und ein echter Concurrency-Lauf unter Last bleiben offen; Sprint 38 adressiert den Restore-Drill.
