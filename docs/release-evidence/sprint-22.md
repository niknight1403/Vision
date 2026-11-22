# Sprint 22 — Reconciliation-Drift

**Nachweis:** `services/api/src/testnet-execution.ts`, `services/api/src/reconciliation-service.ts`, `services/api/src/reconciliation-service.test.ts`.

Die read-only Reconciliation klassifiziert Status-, Instrument-, Side-, Mengen-, Fill-, Preis-, Gebühren-, Provider-ID-, Duplicate-Client-ID- und unbekannte Rohstatus-Abweichungen. Materielle Abweichungen halten an; UNKNOWN wird nicht blind erneut versucht.

**Checks:** API-Unit-Suite bestanden (96 Tests); `git diff --check` bestanden. **Offen:** kein PostgreSQL-Integrations- oder echter Provider-Beleg.
