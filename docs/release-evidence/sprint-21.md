# Sprint 21 — Approval-/Kill-Switch-Ausführungsgate

**Nachweis:** `services/api/src/execution-gate.ts`, `services/api/src/testnet-kill-switch-service.ts`, `services/api/src/execution-gate.test.ts`, `services/api/src/testnet-kill-switch-service.test.ts`.

Das read-only Gate bindet Intent, Payload-Hash, Provider, Account, Umgebung, Instrument, Seite, Menge, Limitpreis und Gebührenlimit. Vollständige Scope-Sets werden fail-closed geprüft; Idempotency-Konflikte werden deterministisch getrennt. Es wurde kein Submit-Worker aktiviert; Testnet-/Live-Freigaben bleiben false.

**Checks:** API-Unit-Suite bestanden (96 Tests); `git diff --check` bestanden. **Offen:** kein echter Provider-/Concurrency-Nachweis.
