# Production release gates

A release is not production-ready merely because a JavaScript bundle or APK exists.

- [ ] TypeScript strict checks pass.
- [ ] Unit tests cover profit, risk, state transitions, and validation.
- [ ] PostgreSQL integration tests cover ledger invariants and concurrent reservations.
- [ ] Durable worker lease, retry, deduplication, outbox, and recovery tests pass.
- [ ] RBAC and session security tests pass.
- [ ] Marketplace sandbox tests verify each declared capability.
- [ ] Approval expiry and price/stock drift invalidate execution.
- [ ] Unknown purchase/payment states reconcile without blind retries.
- [ ] Android install test passes on a real device.
- [ ] Backend health, migration status, artifact SHA256, and build ID are recorded.
- [ ] Emergency stop is server-side and verified.

Until every relevant gate is evidenced, keep LIVE trading disabled.

## Source-code release CI (not a production approval)

The GitHub Actions workflow at `.github/workflows/ci.yml` checks clean lockfile installation, Prisma client generation/schema validation/migrations against PostgreSQL, API build, workspace typechecks, unit and PostgreSQL integration tests, `npm audit --audit-level=high`, and Android Expo bundling. These checks validate repository changes only; they do not satisfy the production gates above or enable live trading.

Local verification passed after a clean `npm ci`: migrations were current, API build and all workspace checks/tests passed, and the Android bundle exported. GitHub Actions CI Run `43990674018` also passed before publication. The public pre-release `v0.1.0` remains the historical baseline; the `v0.2.0` release notes document the new testnet safety primitives and verification evidence. Both are source-code releases, not production approvals. The high/critical audit threshold passes; the current dependency tree still reports 11 moderate advisories in the Expo toolchain. Moderate findings are not a formal risk exception and must be triaged again before any production release.

## Android EAS build profiles

The Expo project has EAS profiles in `apps/mobile/eas.json`:

- `preview` produces an internally distributed installable Android APK.
- `production` produces an Android App Bundle (AAB) and increments the local app version code.

Before the first build, link the Expo project interactively from `apps/mobile` with `npx eas-cli@latest init`. This creates the project association in the Expo app configuration; commit the generated project ID after verifying it belongs to the intended Expo account/project. Authenticate with `npx eas-cli@latest login` (or an `EXPO_TOKEN`/EAS token in CI), then run `npx eas-cli@latest build --platform android --profile preview`.

A successful EAS build is not yet a device-install verification. Download the resulting APK, install it on a supported Android device, and record the build ID and SHA-256 before treating the Android release gate as complete. Do not add Expo credentials or provider secrets to the repository. The EAS profile does not enable LIVE trading; the app remains PAPER-only.

Nach den Auth-Commits schlug CI auf `main` fehl: Die Refresh-Session-Migration lief vor der Migration, die die `User`-Tabelle anlegt, und der API-Build scheiterte an fehlenden ESM-Endungen sowie an der Scrypt-Typisierung. Die Migrationen `20261117014300_deal_candidates` und `20261117014400_auth_sessions` laufen jetzt nach der Basisschema-Migration. Lokal verifiziert mit frischer PostgreSQL-Datenbank: alle sechs Migrationen, API-Build, Typechecks, 56 API- und 15 Core-Tests, `npm audit --audit-level=high` und Android-Export grün. Bestehende Entwicklungsdatenbanken mit den alten Migrationsnamen müssen zurückgesetzt werden (`npx prisma migrate reset`); produktive Daten existieren nicht.
