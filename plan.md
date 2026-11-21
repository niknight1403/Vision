# AUTONOMOUS read-only Implementierungsplan

## Aktueller Umfang

Vision ist ein serverseitiger, authentifizierter und provider-backed Arbeitsablauf für Katalog-Scans, Deal-Bewertung, Vision-Inspection und durable Analyse-Tasks. Der Standardmodus ist **AUTONOMOUS read-only**: echte Provider-Beobachtungen dürfen gelesen und gespeichert werden; Käufe, Listings, Settlement und sonstige Marketplace-Mutationen bleiben deaktiviert. Provider-Credentials verbleiben serverseitig. Die mobile App zeigt Status und Fehlerzustände, ist aber keine Autorisierung für Mutationen.

Vision-Inspection ist ein Analyse-/Audit-Signal und niemals ein Authentizitätsnachweis. `purchaseAuthorized: false` und `authenticityVerified: false` bleiben unveränderlich. Testnet-Sicherheitsprimitive dürfen nur fail-closed arbeiten; Live-Fähigkeit wird nicht aus ihnen abgeleitet.

## Zehn aufeinanderfolgende Sprints

1. **Dokumentations-/Plan-Synchronisierung** — Plan, TODO, Akzeptanzkriterien und harte Live-Blocker auf den aktuellen Status bringen.
2. **Operations-Readiness** — authentifizierte ADMIN/OPERATOR-read-only-Übersicht für Provider, Queue, Outbox, Kill-Switch, Datenbank und Konfiguration; DB-Fehler explizit statt HEALTHY-Fälschung.
3. **Kill-Switch-Sicherheit** — persistente, versionierte TESTNET-Service-Schicht mit CAS und Audit-Hook; fail-closed Lesen.
4. **Reconciliation-Kern** — read-only Runs mit `reconcileOrders`, sauberem Start/Abschluss und Halt-Markierung bei kritischen Diffs; keine automatische Übernahme unbekannter Orders.
5. **Execution-Gate-Härtung** — Fresh-Price/Stock/Fee-Drift, idempotentes Gate, Approval-/UNKNOWN-/Kill-Switch-Prüfungen; Disabled-Adapter bleibt mutativ gesperrt.
6. **Outbox-/Worker-Betrieb** — Lease-Verlust, Retry-Grenzen, Dead-Letter und Fehler-Redaction belastbar machen.
7. **Vision-Auditpersistenz** — nur sichere Minimalpersistenz oder präzise dokumentierter Persistenz-Blocker; niemals Authentizität aus dem Ergebnis ableiten.
8. **API-Hardening** — zentrale Fehler-/Request-Redaction, Payload-Grenzen und in-process Rate-Limits für sensible Auth-/Scan-/Analysis-Routen.
9. **Release-Evidence** — Typecheck, Unit-Tests, Dependency-Audit, Python-Tests sowie Build-ID/SHA256-Nachweise; fehlende PostgreSQL-URL wird als skipped ausgewiesen.
10. **Android-/Release-Gate und Abschluss** — tatsächlichen read-only-Status, Operations-/Task-Fehler und fehlende Gerätetests dokumentieren; Abschluss-Gate mit SHAs und Blockern.

## Akzeptanzkriterien

- Jeder Sprint hat kleine, nachvollziehbare Änderungen, passende Tests/Checks und einen erfolgreichen Commit; DB-Tests werden ohne `DATABASE_URL` als übersprungen ausgewiesen.
- Authentifizierung und ADMIN/OPERATOR-Berechtigung schützen Operations- und mutative Vorbereitungsrouten; read-only-Übersichten geben keine Secrets oder unnötigen Personendaten aus.
- Kill-Switch, Approval, Reconciliation, Outbox und Vision-Audit sind fail-closed, idempotent oder konfliktbewusst und enthalten keine stillen Provider-Mutationen.
- Fehlerantworten redigieren Tokens, Passwörter, Provider-Credentials, Bild-URLs mit sensitiven Querywerten und interne Stacktraces.
- Mobile und Release-Dokumentation behaupten keine Produktionsreife und weisen fehlende reale Geräte-/Provider-/DB-Evidenz aus.

## Harte Live-Blocker

1. Keine ausgewählte reale Marketplace-/Checkout-/Settlement-Integration mit offiziell geprüftem Mutationsvertrag.
2. Keine Produktions-Credentials, Deployment-/Android-Signing-Evidenz und kein nachgewiesenes PostgreSQL-Produktions-Setup.
3. Keine vollständige serverseitige Session-/RBAC-, Ledger-, Reservation-, Reconciliation- und Incident-Evidenz für reale Käufe.
4. Kein unabhängiger Security-, Datenschutz-, Provider- und Android-Gerätetestabnahmeprozess.
5. `testnetEnabled`, `tradingReady`, `purchaseAuthorized` und `authenticityVerified` dürfen nicht live-fähig gesetzt werden.

## Sicherheitsgrenzen

Es gibt keinen echten Checkout, kein Listing, kein Settlement und keine erfundene Provider-Mutation. Ein fehlender Provider, eine nicht erreichbare Prisma-Datenbank, ein unbekannter externer Orderzustand oder ein Drift-/Kill-Switch-Konflikt führt zu einer expliziten Blockierung bzw. Halt-Anforderung. Staging-Synthetic-Provider werden nicht in Produktion verwendet.
