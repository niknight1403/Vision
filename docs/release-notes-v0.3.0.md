# AutonomAgent v0.3.0 — sichere Testnet-Readiness

**Status:** Offizieller Source-Code-Release, keine Produktionsfreigabe  
**Release-Commit:** der Commit, auf den der Tag `v0.3.0` zeigt  
**Vorgesehener Tag:** `v0.3.0`

## Zusammenfassung

v0.3.0 wird als sichere Testnet-Readiness-Version vorbereitet. Der aktuelle Stand erweitert die vorhandene PAPER-only-Basis um versionierte Testnet-Konfiguration, lokale Egress-/Capability-Integrationstests sowie Monitoring- und Alerting-Primitive. Produktionshandel, Echtgeld-Orders und automatische Aktivierung von Testnet bleiben ausgeschlossen.

## Enthalten

- Versionierte `TESTNET`-Runtime-Konfiguration mit exakter Environment-, Provider-, Account- und API-Bindung.
- HTTPS-Allowlist, blockierte Produktionshost-Liste und fail-closed Startup-Verhalten.
- Lokale Testnet-Integrationstests für Konfiguration, Egress-Client, Redirects, Pfad-Escape und read-only Capabilities.
- Read-only Capability-Matrix für Health, Instrumente, Salden, offene Orders, Orderstatus und Fills.
- Monitoring-Regeln für Kill-Switch, UNKNOWN-Orders, Reconciliation, Providerzustand und Drawdown.
- Alert-Fingerprints und Cooldown-Deduplizierung.
- Sichere Telegram- und Discord-Transporte mit URL-/Credential-Validierung, Mentionschutz und 10-Sekunden-Timeout.
- Lokale Tests mit injizierten Transporten; keine echten Telegram-/Discord-Nachrichten.
- Bestehende PAPER-only-, fail-closed- und Disabled-Provider-Grenzen bleiben aktiv.

## Verifikation des aktuellen Ausgangspunkts

Der aktuelle Commit `dea75e8` wurde lokal mit Prisma/PostgreSQL, API-Build, Workspace-Typechecks, vollständiger Testsuite, Audit-Schwelle und Android-Expo-Export verifiziert. Zuletzt bestanden 129 Tests: 86 API-Tests und 43 Trading-Core-Tests. Die Datenbank verfügt über sieben angewendete Migrationen. Die 11 moderaten Expo-Toolchain-Advisories bleiben als separater Upgrade-Track offen.

## Noch vor dem finalen v0.3.0-Tag abzuschließen

Die Sprints 52–60 des v0.3.0-Plans sind noch offen. Dazu gehören Secret-Manager-Runtime und Redaction, persistenter Kill-Switch-Service mit CAS-Versionierung, Approval-/Intent-Service, Transactional Outbox, Reconciliation-Worker mit Lease und Watermark, Ledger-Anbindung, authentifizierte Operator-Workflows, Fault Injection, Observability-Runbook und die finale Release-Härtung.

Vor dem Tag müssen außerdem CI auf dem finalen Commit, PostgreSQL-Konkurrenztests, Migrationsevidenz, Secret-Scan, Alert-Failure-Verhalten, Android-Export, Audit-Schwelle, Release-Gates und der explizite Status „kein Produktionshandel“ dokumentiert werden.

## Sicherheits- und Reifehinweis

Dies ist kein Produktionsrelease. `PAPER` bleibt der Standardmodus. Testnet ist standardmäßig deaktiviert; ein konfiguriertes `TESTNET_ENABLED=true` wird vom aktuellen Startup weiterhin fail-closed abgelehnt. Es gibt keine Produktionshosts, keine Abhebungen, keine Transfers, keinen Margin-Handel und keinen automatischen Kill-Switch-Reset.

## Tagging- und Veröffentlichungsablauf

Das finale Tag darf erst auf dem letzten grünen Release-Commit angelegt werden:

```bash
git status --short
git diff --check
npm run build --workspace @autonomagent/api
npm run typecheck
npm test
npm audit --audit-level=high
( cd apps/mobile && npx expo export --platform android --output-dir /tmp/autonomagent-v030-android-export )
git tag -a v0.3.0 -m "release: AutonomAgent v0.3.0"
git push origin main
git push origin v0.3.0
gh release create v0.3.0 --target HEAD --title "AutonomAgent v0.3.0" --notes-file docs/release-notes-v0.3.0.md
```

Dieses Release ist ein offizieller Source-Code-Release. Die noch offenen Sprints 52–60 bleiben Folgearbeiten; sie blockieren nicht die Veröffentlichung dieses sicheren Readiness-Standes, ersetzen aber keine Produktions-Release-Gates.
