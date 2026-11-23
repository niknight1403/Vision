# Vierzig-Sprint-Release-Gate — Sprints 31–40

**Zweck:** Abschluss-Nachweis für die Sprints 31–40. Dieses Dokument hält fest, welche Commits
tatsächlich auf `main` liegen, welche Gates in der Sandbox **wirklich ausgeführt** wurden, mit
welchem Ergebnis, und was weiterhin fehlt. Es ist ein Source-/Test-Gate und **keine
Produktionsfreigabe**.

**Datum:** 2026-11-23 · **Branch:** `main` · **HEAD / origin/main beim Lauf:**
`6f1d2320a6dea779d5fd5e9790ac52727477831f` ("feat(mobile): testable api client with backoff
polling and session expiry handling (sprint 39)"). Der Gate-Commit selbst ist der Commit, der diese
Datei enthält; seine SHA steht nicht in der Datei (Selbstreferenz) und ist im Abschlussbericht
sowie in `git log --oneline -1` nachlesbar.

Alle SHAs unten wurden per `git fetch origin` + `git log origin/main --grep="(sprint N)"`
verifiziert, nicht aus einer Aufgabenbeschreibung übernommen. Zehn separate Sprint-Commits
existieren für 31–39; Sprint 40 ist der Gate-Commit selbst.

## Commit-Evidence der Sprints 31–40

| Sprint | SHA | Kurzbeschreibung | Evidence-Datei |
|---:|---|---|---|
| 31 | `2377ed24efca808f4fee991ca847d478609d69cc` | Python-Testnachweis: Download-Guards (private/loopback/metadata DNS, Größen-, Typ-, Signatur-Checks) und `/v1/analyze`-Auth/Validierung; `npm run test:python` reproduzierbar aus dem Repo-Root | `docs/release-evidence/sprint-31.md` |
| 32 | `a18d01bb54ea89d3e160458335d75cebb8a06063` | PostgreSQL-Integrationssuite lauffähig gemacht (Glob war ein Substring-Filter) und Treasure-Analyse-Idempotenz kanonisch gehasht; lokales Cluster-Skript | `docs/release-evidence/sprint-32.md` |
| 33 | `5f5438600291f89cd83f3a98b5b9dc95f4fab9ab` | Egress-Pinning gegen DNS-Rebinding: einmalige Auflösung, Verbindung auf die geprüfte IP, TLS/SNI bleibt intakt, eigener begrenzter HTTP-Client, keine Redirects | `docs/release-evidence/sprint-33.md` |
| 34 | `0f9b48d87293e269fdc3269b6fdf8c0d1d39bfca` | Vision-Worker-HTTP-Härtung: 64-KiB-Payload-Limit, harte Analyse-Deadline, begrenzte Parallelität (503 `WORKER_BUSY`), `x-request-id`, redigierte Fehler, getrennte Liveness/Readiness | `docs/release-evidence/sprint-34.md` |
| 35 | `8a0260079ff4e883cc5a0de9f5da91e9172227e7` | Sliding-Window-Rate-Limits mit `Retry-After`, harter Key-Begrenzung und fail-closed Konfiguration; verdrahtet auf Login/Refresh/Scan/Analyse/Vision | `docs/release-evidence/sprint-35.md` |
| 36 | `86e4127f319751fb291674b2d680ddfb9f8f8fe2` | Outbox-Lease-Reaper, Statuszähler und begrenztes Dead-Letter-Replay (`replayCount`, additive Migration), redigierte `lastError` | `docs/release-evidence/sprint-36.md` |
| 37 | `f486ec74ccc3697be4b17012634fbf0a2b05efe3` | Prometheus-`/metrics` hinter `METRICS_TOKEN`, Karten-/Serienlimits, Routen-Template-Labels, `x-request-id`-Korrelation und Alert-Regeln | `docs/release-evidence/sprint-37.md` |
| 38 | `b4b24ea96cce90b751c9ccc6be03b4ae62f05ed6` | Backup-/Restore-Drill mit Tabellen-, Zeilen- und Migrationsvergleich inkl. Negativfall; Runbook | `docs/release-evidence/sprint-38.md` |
| 39 | `6f1d2320a6dea779d5fd5e9790ac52727477831f` | Geräteunabhängige Mobile-API-Schicht: typisierte Fehler, Single-Flight-Refresh, Backoff-Polling, Session-Ablauf; 43 Unit-Tests, UI darauf verdrahtet | `docs/release-evidence/sprint-39.md` |
| 40 | *dieser Commit* | Dieses Gate: alle Checks real ausgeführt, Zahlen gesammelt, Blocker und Nicht-Aussagen dokumentiert; README/TODO/Plan synchronisiert | `docs/forty-sprint-release-gate.md` |

Hinweis: `docs/release-evidence/sprint-30.md` existiert nicht; der Sprint-30-Nachweis liegt im
Commit `46b2bd7` ("docs: add thirty-sprint release gate") in `docs/thirty-sprint-release-gate.md`.

## Gate-Checks (alle in dieser Sandbox ausgeführt)

| # | Kommando | Ergebnis | Testzahl / Kennzahl |
|---:|---|---|---|
| 1 | `npm run typecheck` (Repo-Root, alle Workspaces) | **grün**, Exit 0 | 3 Workspaces: mobile, api, trading-core — je `tsc --noEmit` ohne Fehler |
| 2 | `npm test` (Repo-Root) | **grün**, Exit 0 | **198 Tests in 32 Dateien**: mobile 43 (2 Dateien), api 112 (23 Dateien), trading-core 43 (7 Dateien) |
| 3 | `pg_isready -h 127.0.0.1 -p 5432` | **bereits laufend** (`accepting connections`), `scripts/local-postgres.sh` daher nicht erneut nötig | PostgreSQL lokal, DB `autonomagent_test` |
| 4 | `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/autonomagent_test?schema=public npm run test:db --workspace @autonomagent/api` | **grün**, Exit 0 | **37 Tests in 7 Dateien, 0 skipped**; davon 33 Integrationstests in 6 Integrationsdateien (Gate-Skript: `PostgreSQL integration gate passed`) |
| 5 | `npm run test:python` (pytest, `services/vision-worker`) | **grün**, Exit 0 | **68 passed**, 1 Deprecation-Warnung (`httpx`/`starlette.testclient`), 0 skipped |
| 6 | `npm run audit:gate` (`scripts/audit-gate.mjs`) | **grün**, Exit 0 | 0 Root-Advisories, 0 Ausnahmen in Gültigkeit; `npm audit`: 0 high, 0 critical, 0 moderate, 0 low |
| 7a | `npm run build` — **Skript existiert im Root nicht** (`package.json` hat kein `build`); `@autonomagent/trading-core` hat ebenfalls kein Build-Skript (wird als TS-Quelle konsumiert) | n/a | begründet: kein Root-/Core-Build vorhanden, deshalb die nächstliegenden echten Builds (7b, 7c) |
| 7b | `npm run build --workspace @autonomagent/api` (`tsc -p tsconfig.build.json`) | **grün**, Exit 0 | `services/api/dist` erzeugt |
| 7c | `npx expo export --platform android --output-dir /tmp/expo-export-verify` | **grün**, Exit 0 | Android-Hermes-Bundle erzeugt: 603 Module, 1,6 MB (`index-*.hbc`), Metro-Bundling 3,1 s |
| 8 | `DATABASE_URL=… node scripts/backup-restore-drill.mjs` | **PASSED**, Exit 0 | 14 Tabellen / 14 wiederhergestellt, 9 Zeilen / 9, 9 Migrationen / 9, Dump 39 540 Bytes, sha256 `21fdda1b…` |
| 9 | `git diff --check` | **grün** | keine Whitespace-/Konfliktmarker-Fehler |

### Einordnung der Zahlen

- `npm test` erwartete mobile ~43, api ~112, trading-core 43 — **exakt bestätigt** (198 gesamt).
- Die DB-Suite wuchs über die Sprints von 20 (Sprint 32) über 22/29 (35/36) auf **33
  Integrationstests in 6 Dateien** (Sprint 37/40). Die 37 Gesamttests enthalten 4 Unit-Tests, die
  im selben Lauf mitlaufen; das Gate-Skript zählt separat 33 Integrationstests.
- **Der Restore-Drill verglich in diesem Lauf faktisch ein leeres Anwendungsschema:** 9 der 9
  Zeilen sind `_prisma_migrations`. Die 13 Anwendungstabellen waren leer, weil die DB-Suite ihre
  Zeilen selbst aufräumt. Der Vergleich von Tabellenliste, Zeilenzahl (0 = 0) und
  Migrationsstand ist damit bestanden, aber schwach. Dass der Vergleich Abweichungen tatsächlich
  erkennt, wurde in Sprint 38 mit 38 Seed-Zeilen und einem deterministischen Negativfall
  (`pg_restore`-Wrapper löscht eine Zeile → Drill schlägt fehl) belegt. Die Dump-SHA256 ist pro
  Lauf unterschiedlich (Zeitstempel im Dump) und daher kein Stabilitätsmerkmal.
- Die Drill-Zahlen dieses Laufs (9 Zeilen, 39 540 Bytes) weichen bewusst von Sprint 38
  (38 Zeilen, 41 237 Bytes) ab, weil dort temporäre Seed-Zeilen existierten.

## Ehrliche Blocker-Liste

1. **Keine Gerätetests.** Kein Android-Gerät, kein Emulator, kein `adb`, kein JDK, kein Android
   SDK in der Umgebung. Die Mobile-Evidenz ist Typecheck + Node-Unit-Tests + JS/Hermes-Bundle —
   kein Laufzeitverhalten auf einem Telefon, kein Rendering, kein SecureStore-/Keystore-Zugriff.
2. **Kein E2E gegen eine echte API.** Mobile und API wurden nie gemeinsam über HTTP gestartet;
   alle API-Tests laufen in-process (Fastify-`inject`) bzw. gegen lokales Postgres.
3. **Keine Live-Marketplace-Mutation.** Kein Kauf, kein Listing, kein Settlement, keine
   Stornierung — weder gegen Sandbox noch gegen Produktion. Mutierende Adapter bleiben
   deaktiviert.
4. **Keine Provider-Zugangsdaten.** Kein echter Katalog-/Sold-Listing-/Vision-Provider mit
   Credentials; Market Research bleibt ohne echten Sold-Listing-Provider nicht verfügbar.
5. **Kein PITR / Offsite-Backup.** Der Drill nutzt `pg_dump` auf dasselbe lokale Cluster, keine
   Point-in-Time-Recovery, kein WAL-Archiving, kein Offsite-Ziel, kein Restore in eine echte
   Staging-/Produktionsdatenbank, keine Wiederherstellungszeit-Messung (RTO/RPO).
6. **In-Process-Rate-Limit statt Gateway.** Der Limiter lebt im Prozess; mehrere Replicas
   multiplizieren das effektive Limit. Ein geteilter Limiter (Gateway/Redis) fehlt.
7. **Keine Lasttests.** Keine Soak-/Burst-/Multi-Client-Läufe, keine Messung von Latenz oder
   Durchsatz unter Last, kein echter Prometheus-Scrape und kein Dashboard.
8. **Kein Produktions-Deployment.** Keine Container-Registry, kein Orchestrator, keine
   Netzwerkpolicy/Egress-Firewall im Deployment, keine TLS-Terminierung, keine Secrets-Verwaltung.
9. **Betriebsprozesse sind Funktionen, keine Scheduler.** Lease-Reaper und Dead-Letter-Replay
   müssen von einem Betriebsprozess periodisch aufgerufen werden; ein echter Multi-Prozess-Crash-
   Test mit mehreren Workern fehlt.
10. **Keine unabhängige Abnahme.** Keine externe Security-, Datenschutz-, Provider- oder
    Betriebsprüfung; keine Play-Store-Signierung/Distribution; kein Incident-Runbook-Drill.
11. **Nur lokale PostgreSQL-Instanz.** Getestet gegen ein Wegwerf-Cluster (PostgreSQL 15/16) auf
    `127.0.0.1`; keine Aussage über ein Produktions-Cluster, Replikation oder Failover.

## Was dieses Gate NICHT belegt

- **Keine Produktionsreife.** Grüne lokale Checks sind kein Release-Signal. Es gibt keine
  Deployment-, Skalierungs-, Disaster-Recovery- oder Betriebsabnahme-Evidenz.
- **Keine echten Käufe oder Listings.** Es wurde nichts gekauft, verkauft, gelistet, bezahlt oder
  abgerechnet. `purchaseAuthorized`, `authenticityVerified`, `tradingReady` und `testnetEnabled`
  bleiben `false`/fail-closed.
- **Keine Live-Provider.** Weder Vision-Modell noch Katalog noch Sold-Listing-Provider wurden mit
  echten Credentials aufgerufen. Die Vision-Spezialisten laufen in Tests gegen Doubles.
- **Keine Aussage über ein echtes Gerät.** Die mobile App wurde gebündelt, nicht installiert und
  nicht bedient.
- **Keine Sicherheitsgarantie der Deployment-Umgebung.** DNS-Pinning und private-Netz-Sperren sind
  im Code bewiesen; die Egress-Firewall/NetworkPolicy des Deployments ist nicht nachgewiesen.
- **Keine Datenintegritätsgarantie unter Last.** Concurrency-/Race-Verhalten wurde nur
  deterministisch in Tests, nicht unter echtem parallelem Traffic geprüft.

## Reproduktion

```bash
cd Vision
git fetch origin && git log --oneline -20 origin/main
npm run typecheck
npm test
pg_isready -h 127.0.0.1 -p 5432 || bash scripts/local-postgres.sh
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/autonomagent_test?schema=public' \
  npm run test:db --workspace @autonomagent/api
npm run test:python
npm run audit:gate
npm run build --workspace @autonomagent/api
npx expo export --platform android --output-dir /tmp/expo-export-verify
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/autonomagent_test?schema=public' \
  node scripts/backup-restore-drill.mjs
```
