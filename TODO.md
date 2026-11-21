# TODO — AUTONOMOUS read-only Release-Gates

## Bereits geliefert

- Authentifizierte Sessions, Rollenprüfung und serverseitige Provider-Konfiguration.
- Provider-backed Deal-Scan mit echten Beobachtungen; kein Fixture-/Synthetic-Provider in Produktion.
- Durable Vision-Analyse-Tasks mit Idempotenz, Outbox und Worker-Lease.
- Vision-Inspection als Analysebefund; `purchaseAuthorized` und `authenticityVerified` bleiben immer `false`.
- TESTNET-Sicherheitsprimitive und deaktivierter mutierender Adapter; LIVE bleibt gesperrt.

## Zehn Sprint-Ziele

1. **Dokumente synchronisieren:** aktueller Scope, Akzeptanzkriterien und harte Live-Blocker sind in `plan.md` festgehalten.
2. **Operations-Readiness:** geschützte read-only Übersicht für ADMIN/OPERATOR; Provider-, Queue-, Outbox-, Kill-Switch-, DB- und Konfigurationsstatus ohne Secrets; DB-Ausfall ist expliziter Fehler.
3. **Kill-Switch:** versionierter TESTNET-CAS-Service mit fail-closed Lesen und Audit-Outbox-Hook.
4. **Reconciliation:** read-only `ReconciliationRun`-Lebenszyklus, kritische Diffs markieren `HALT_REQUIRED`; unbekannte externe Orders werden nicht übernommen oder retried.
5. **Execution-Gate:** frische Preis-/Bestands-/Gebühren-Drift und idempotente Gate-Entscheidungen; kein Provider-Mutation.
6. **Outbox/Worker:** Lease-Verlust, Retry-Limit, Dead-Letter und redigierte `lastError`-Werte testen.
7. **Vision-Audit:** sichere Minimalpersistenz nur mit passender Migration; sonst Persistenz-Blocker dokumentieren und Audit-Semantik verschärfen.
8. **API-Hardening:** zentrale Redaction, Payload-Limits und begrenztes in-process Rate-Limit auf sensible Routen.
9. **Release-Evidence:** Typecheck, Unit-/Python-Tests, Dependency-Audit, Build-ID/SHA256; PostgreSQL ohne URL als skipped/reportiert.
10. **Android/Abschluss:** read-only UI, Operations-/Task-Fehlerzustände, fehlende echte Gerätetests und `docs/ten-sprint-release-gate.md`.

## Harte Blocker — keine Produktionsfreigabe

- Keine reale Marketplace-Auswahl und kein geprüfter offizieller Checkout-/Listing-/Settlement-Mutationsvertrag.
- Keine Produktions-Credentials, Deployment- oder Android-Signing-Evidenz und kein bestätigtes PostgreSQL-Produktionssetup.
- Keine vollständige unabhängige Security-, Datenschutz-, Provider- und reale Gerätetestabnahme.
- `testnetEnabled`, `tradingReady`, `purchaseAuthorized` und `authenticityVerified` bleiben fail-closed bzw. `false`.
- Unbekannte Orders, DB-Ausfall, Konfigurationsfehler, fehlende Provider und kritische Drift blockieren statt zu heilen.

## Offene Nachweise

Reale Provider-Auswahl, Credentials, PostgreSQL-Integration, Android-Installations-/Gerätetests, Migration-Runbook, Incident-Runbook und unabhängige Sicherheitsabnahme fehlen weiterhin. Demo- und Testdaten sind ausschließlich als solche gekennzeichnet.
