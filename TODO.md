# TODO — AUTONOMOUS read-only Release-Gates

## Bereits geliefert

- Authentifizierte Sessions, Rollenprüfung und serverseitige Provider-Konfiguration.
- Provider-backed Deal-Scan mit echten Beobachtungen; kein Fixture-/Synthetic-Provider in Produktion.
- Durable Vision-Analyse-Tasks mit Idempotenz, Outbox und Worker-Lease.
- Vision-Inspection als Analysebefund; `purchaseAuthorized` und `authenticityVerified` bleiben immer `false`.
- TESTNET-Sicherheitsprimitive und deaktivierter mutierender Adapter; LIVE bleibt gesperrt.

## Sprints 31–40 — abgeschlossen (Gate: `docs/forty-sprint-release-gate.md`)

Alle zehn Sprints sind committed; die SHAs und die real ausgeführten Checks stehen im Gate-Dokument.

- [x] **31** — Python-Testnachweis für Download-Guards und `/v1/analyze` (`npm run test:python` reproduzierbar).
- [x] **32** — PostgreSQL-Integrationssuite lauffähig, Idempotenz-Hash kanonisch, lokales Cluster-Skript.
- [x] **33** — Egress-Pinning gegen DNS-Rebinding mit intaktem TLS/SNI, keine Redirects.
- [x] **34** — Vision-Worker: 64-KiB-Limit, Deadline, begrenzte Parallelität, `x-request-id`, redigierte Fehler.
- [x] **35** — Sliding-Window-Rate-Limits mit `Retry-After` und fail-closed Konfiguration.
- [x] **36** — Outbox-Lease-Reaper, Statuszähler, begrenztes Dead-Letter-Replay.
- [x] **37** — Prometheus-`/metrics` hinter Token, Kartenlimits, Request-Korrelation, Alert-Regeln.
- [x] **38** — Backup-/Restore-Drill mit Tabellen-, Zeilen- und Migrationsvergleich plus Negativfall.
- [x] **39** — Geräteunabhängige Mobile-API-Schicht mit typisierten Fehlern, Single-Flight-Refresh und Backoff-Polling.
- [x] **40** — Abschluss-Gate: Typecheck, 198 JS-Tests, 37 DB-Tests, 68 pytest, Audit, Builds, Restore-Drill; Blocker dokumentiert.

### Verbleibende Blocker nach Sprint 40

- Keine Android-Geräte-/Emulator-Tests, kein `adb`/SDK/JDK in der Umgebung; nur Typecheck, Unit-Tests und Hermes-Bundle.
- Kein E2E-Lauf Mobile → echte API über HTTP.
- Keine Live-Marketplace-Mutation (kein Kauf, Listing, Settlement) und keine Provider-Credentials.
- Kein PITR-/Offsite-Backup, kein Restore in ein echtes Staging/Produktion; der Drill lief gegen ein faktisch leeres Anwendungsschema.
- In-Process-Rate-Limit statt Gateway/Redis; keine Last-/Soak-Tests, kein echter Prometheus-Scrape.
- Kein Produktions-Deployment, keine Egress-Firewall-/NetworkPolicy-Evidenz, keine unabhängige Security-/Datenschutz-Abnahme.

## Frühere Zehn-Sprint-Ziele (abgeschlossen, historisch)

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

Reale Provider-Auswahl, Credentials, Android-Installations-/Gerätetests, Incident-Runbook-Drill, PITR/Offsite-Backup, Lasttests und unabhängige Sicherheitsabnahme fehlen weiterhin. PostgreSQL-Integration ist lokal nachgewiesen (37 Tests), aber nicht in einem Produktions-Cluster. Demo- und Testdaten sind ausschließlich als solche gekennzeichnet.
