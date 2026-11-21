# Ten-sprint release gate

**Stand:** 2026-11-21 · **Repository:** `Vision` · **Bewertung:** Source-code evidence only, **keine Produktionsfreigabe**

## Commit provenance

Die folgenden SHAs stammen aus dem lokalen `git log`; für Sprint 9 und 10 wurden sie nach den jeweiligen Commits erneut gegen `origin/main` geprüft.

| Sprint | Commit-Evidence | Status / Zuordnung |
|---:|---|---|
| 1 | `5183d34a012df4917b2987d6a116bab0274013f7` | Plan/TODO auf den aktuellen AUTONOMOUS-read-only-Stand synchronisiert; nach Commit nach `origin/main` gepusht. |
| 2 | `948d27bddc5aeeb65ed7a154fa52a6b37c4551c3` | Authentifizierte read-only Operationsübersicht; nach Commit nach `origin/main` gepusht. |
| 3 | `11c4a1cf8352c9ea4d46f85c674b2c15f903ac99` | Versionierter TESTNET-Kill-Switch mit fail-closed Lesen und CAS; nach Commit nach `origin/main` gepusht. |
| 4 | `a29ee4ed5678395d966af86587974e3266b805f6` | Read-only-Reconciliation-Service und ReconciliationRun-Lebenszyklus; nach Commit nach `origin/main` gepusht. |
| 5 | `1be163b64b1a16dd8241d81c9d7e088d2c7e70d7` | Fresh-Price/Stock/Fee-Drift und Client-Order-ID-Gate; nach Commit nach `origin/main` gepusht. |
| 6 | `90bafb90cee7116eac21ad801b172455bdd93ac0` | Outbox-Fehlerredaction und begrenzte lastError-Werte; nach Commit nach `origin/main` gepusht. |
| 7 | `b128f34df5e9278dff5a14ce6a6e869f4afb06ab` | Vision-Auditpersistenz-Gate dokumentiert, keine halbe Migration; nach Commit nach `origin/main` gepusht. |
| 8 | `cad3611e1fd68ce3bb1a5542393983f9594edc8d` | Zentrale Redaction und dependency-freie in-process Rate-Limit-Grundlage; nach Commit nach `origin/main` gepusht. |
| 9 | `4ab97a27565cfa85f1e9d422b8ac2293da4ac95c` | CI-Evidence-Skript sowie SHA-/Build-ID-/Artefakt-Evidence für den Android-JS-Export; nach Commit nach `origin/main` gepusht. |
| 10 | `6423ccd51ff8eed347155037c930d810d44e3ecf` plus dieser Gate-Dokumentationscommit | Mobile-Polling bleibt nach transienten Fehlern aktiv; UI zeigt `POLLING`, `FAILED` und Retry-Hinweise ohne fachliche Kaufwiederholung. |

Vor Sprint 9 war der vom Auftrag angegebene Stand `cad3611e1fd68ce3bb1a5542393983f9594edc8d`; er wurde bestätigt als HEAD und `origin/main` vor Beginn.

## Kanonischer Sicherheitsstatus

- Betriebsmodus bleibt **AUTONOMOUS**, read-only und provider-backed analysis.
- Live execution ist deaktiviert. `tradingReady`, `purchaseAuthorized` und `authenticityVerified` bleiben fail-closed/false; `testnetEnabled` bleibt deaktiviert.
- Es wurde keine Marketplace-Checkout-, Payment-, Listing-, Settlement- oder sonstige Provider-Mutation aktiviert.
- Kill-Switch, Approval und Reconciliation sind Grundlagen bzw. read-only Sicherheitsgates, keine Live-Ausführung.
- Die Mobile-Oberfläche stellt laufende Zustände als `POLLING · QUEUED/RUNNING/CHECKPOINTED`, terminale Fehler als `FAILED` und HTTP-/Netzwerkprobleme als `POLLING_FAILED` bzw. `POLLING_RETRYING` dar. Ein transienter Fehler beendet den Timer nicht.

## Ausgeführte Checks

| Check | Ergebnis | Nachweis / Einschränkung |
|---|---|---|
| `npm run typecheck` | bestanden | Mobile, API und trading-core. |
| `npm test` | bestanden mit Skip | 96 Tests bestanden; 20 PostgreSQL-Integrationstests übersprungen, weil lokal kein `DATABASE_URL` gesetzt war. |
| `npm run build --workspace @autonomagent/api` | bestanden | TypeScript-API-Build erfolgreich. |
| `npm run audit:gate` | bestanden | 0 high, 0 critical, 0 moderate, 0 low, 0 info im lokalen Audit. |
| `DATABASE_URL=postgresql://... npx prisma validate --schema services/api/prisma/schema.prisma` | bestanden | Schema syntaktisch validiert; keine Datenbankverbindung behauptet. |
| `npx prisma validate` ohne `DATABASE_URL` | nicht ausführbar | Prisma meldete erwartungsgemäß `Environment variable not found: DATABASE_URL`. |
| `git diff --check` | bestanden | Vor den Commits ohne Whitespace-Fehler. |
| Python `pytest` | übersprungen | `pytest` ist in dieser Umgebung nicht installiert; kein Python-Ergebnis behauptet. CI sieht einen Python-Testjob vor und installiert dort `.[test]`. |
| Android-Export / echter Gerätetest | übersprungen | Kein Android SDK/ADB und kein echtes Gerät in dieser Umgebung. CI workflow exportiert den JS-Bundle; `scripts/release-evidence.mjs` schreibt dafür Git-SHA, Build-ID und SHA256. |
| PostgreSQL-Migration/Integration | übersprungen | Kein lokaler PostgreSQL-Dienst / kein `DATABASE_URL`; die CI-Jobs nutzen PostgreSQL 16 und 15 und failen, wenn Integrationstests skippen. |

## Harte verbleibende Blocker

1. Die 20 lokalen PostgreSQL-Integrationstests benötigen eine echte PostgreSQL-Instanz und bleiben offen, bis sie gegen PostgreSQL ausgeführt wurden.
2. Eine echte Android-Geräteinstallation, Startprüfung und Produktionssignierung fehlen. Der CI-Preview-/JS-Export ist kein Gerätebeweis und keine Store-Freigabe.
3. Es gibt keine ausgewählte und freigegebene offizielle Marketplace-Mutation-/Settlement-Integration.
4. Kill-Switch, Approval und Reconciliation besitzen trotz Grundlagen keine aktivierte Live-Ausführung; diese bleibt absichtlich deaktiviert.
5. Python-`pytest` wurde lokal nicht ausgeführt, weil es nicht installiert ist.
6. Keine echten Credentials wurden erzeugt oder in das Repository aufgenommen.

## Abschlussprüfung

Nach dem Sprint-10-Dokumentationscommit müssen `git rev-parse HEAD`, `git rev-parse origin/main` und `git status --short --branch` erneut ausgeführt werden. Erwartet wird ein sauberer Arbeitsbaum mit `HEAD == origin/main`; diese Gleichheit ist eine Repository-Prüfung, keine Produktionsfreigabe.
