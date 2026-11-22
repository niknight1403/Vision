# Sprint 23 — API-Limits, Fehlervertrag und Korrelation

**Nachweis:** `services/api/src/api-hardening.ts`, `services/api/src/app.ts`, `services/api/src/api-hardening.test.ts`, `services/api/src/auth-service.ts`.

Der API-Hardening-Pfad zentralisiert konservative, route-/Principal-/IP-bezogene Limits sowie sichere Request-/Correlation-IDs und Redaction. Fehlerantworten geben keine internen Fehler oder Secrets preis; Login, Refresh, Scan, Analyse und Operator-Pfade bleiben serverseitig zu verdrahten/zu betreiben.

**Checks:** API-Unit-Suite bestanden (96 Tests), Audit-Gate bestanden; `git diff --check` bestanden. **Offen:** kein Reverse-Proxy-/Produktionslasttest.
