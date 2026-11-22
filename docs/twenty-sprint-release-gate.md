# Twenty-sprint release gate (Sprints 11–20)

**Stand:** 2026-11-21 · **Repository:** `Vision` · **Bewertung:** Source-code evidence only · **Keine Produktionsfreigabe**

## Commit evidence

| Sprint | SHA | Ergebnis |
|---:|---|---|
| 11 | `4732d25abe503f89e3a6ea27216b57f8fde4f698` | Unit-/DB-Testpfade getrennt; explizites PostgreSQL-Erreichbarkeits-Gate ohne `DATABASE_URL` oder Instanz; Skippen kann nicht als grün gelten. |
| 12 | `da34f23a4147b1205abf28f778d024bc9d3f3788` | Additive fail-closed Wallet-/Reserve-/Approval-Checks, Prechecks, Foreign Keys und Backfill-Runbook. |
| 13 | `3a90b93e725e182a314416b19f3a139e2d2eebb9` | Ausführbarer Vision-Worker nutzt zentrale Claim-/Lease-/Heartbeat-/Fencing-/Retry-Primitiven. |
| 14 | `0e42e393b9955ee312cffc2b7fbe13e5f6ae4fe3` | Treasure-Analysis-Erzeugung auf zentralen idempotenten Task-Service umgestellt; Unique-Races verwenden denselben Konfliktpfad. |
| 15 | `292410a57ff3fd7cef4d08f85c973aafa7e2930f` | Outbox-`markFailed` prüft Lease-Besitz und meldet Lease-Verlust nicht als Retry-/DLQ-Erfolg. |
| 16 | `32e2053b7f1607388c24a87433cbafd366cdae6c` | Strikte vollständige Kill-Switch-Scope-Prüfung für fehlende, doppelte, unbekannte, stale/future und blockierende Scopes. |
| 17 | `4eb8fb8e07572b8d0f73b165664649812ff11048` | Reconciliation erkennt unbekannte Rohstatus und Mengenüberschreitungen und klassifiziert sie haltkritisch. |
| 18 | `64d87fd490717b336ec42b8457a35e8584acc9df` | `/livez`, DB-abhängiges `/readyz` und nicht-positives `/health` bei DB-Ausfall. |
| 19 | `da91aabb6b7434d6c48277b499c6f757f80e086d` | SecureStore-/Mobile-Session-Gate dokumentiert; keine unsichere Tokenpersistenz eingeführt. |
| 20 | `dfcc2ce473b208a8a0c0317c329a1eebbe5ba475` | Sichere `LLM_BASE_URL`-Allowlist/TLS-/Endpoint-Prüfung; reproduzierbare Evidence und dieser Abschlussnachweis. |

## Checks and evidence

- `npm run typecheck`: lokal bestanden vor Sprint 18; API-Typecheck nach den Änderungen in Sprints 13–19 bestanden.
- API-Unit-Suite: **96 Tests bestanden**, keine DB-Integrationstests in der Unit-Suite.
- `npm test`: Unit-/Core-Tests lokal bestanden; PostgreSQL-Suites sind bewusst separiert.
- `npm run test:db --workspace @autonomagent/api`: lokal **nicht grün**, weil `DATABASE_URL` fehlt. Das neue Gate beendet den Lauf mit offenem Nachweis; es wird kein Skip als Erfolg gewertet.
- `git diff --check`: vor jedem Commit ausgeführt und bestanden.
- Prisma Validate: mit syntaktisch gültigem, absichtlich nicht erreichbarem DSN bestanden; es ist kein Datenbankzugriff behauptet.
- Python `pytest`: lokal nicht ausgeführt, da `pytest` in der Umgebung nicht verfügbar ist.
- Android SDK/ADB/echtes Gerät: nicht verfügbar; kein Installations-, Signierungs- oder Store-Nachweis behauptet.
- Audit/API-Build/Android-Bundle: frühere Repository-Evidence bleibt historische Source-Code-Evidence und ersetzt keinen Live-/Gerätenachweis.

## Remaining hard blockers

Live-Käufe, Listings, Payments, Settlement und Provider-Mutationen bleiben deaktiviert. `testnetEnabled`, `tradingReady`, `purchaseAuthorized` und `authenticityVerified` bleiben fail-closed/false. Es fehlen weiterhin echte PostgreSQL-Integrations-/Concurrency-Nachweise, Python-Testnachweise, SecureStore-/Refresh-/Logout-/Origin-Tests auf Mobile, Android-Gerätetest und Produktionssignierung, echte Provider-Credentials sowie unabhängige Security-, Datenschutz- und Betriebsabnahmen. Die Vision-LLM-Egress-Allowlist ist implementiert, aber DNS-Rebinding-/private-Netz-Blockade muss zusätzlich durch die reale Netzwerkumgebung erzwungen und nachgewiesen werden.
