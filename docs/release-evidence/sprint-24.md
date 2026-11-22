# Sprint 24 — Lease-Fencing

**Nachweis:** `services/api/src/agent-task-service.ts`, `services/api/src/outbox-worker.ts`, `services/api/src/agent-task-service.test.ts`, `services/api/src/outbox-worker.test.ts`.

Task-Claims und Outbox-Acknowledge/Failure verwenden Lease- und Worker-Fencing in den zustandsändernden Bedingungen. Wiederverwendete Worker-Namen dürfen keine abgelaufenen Claims wiederbeleben. Tests bleiben ohne externe Seiteneffekte.

**Checks:** API-Unit-Suite bestanden (96 Tests); `git diff --check` bestanden. **Offen:** PostgreSQL-Race-Test wegen fehlender Datenbank nicht ausführbar.
