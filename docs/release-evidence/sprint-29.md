# Sprint 29 — Restore-/Backup-/Dependency-Evidence

**Nachweis:** `docs/database-invariants-runbook.md`, `services/api/scripts/require-postgres.mjs`, `services/vision-worker/pyproject.toml`, `package-lock.json`.

Das Repository enthält ein dokumentiertes DB-Invarianten-/Migrationsvorgehen und reproduzierbare npm-Abhängigkeiten. Das DB-Gate bricht bei fehlendem `DATABASE_URL` hart ab; es wird kein grüner Skip erzeugt. Python-Testabhängigkeiten sind deklarativ, aber lokal nicht installiert.

**Checks:** Audit-Gate bestanden; DB-Gate korrekt offen/fail-closed. **Skip:** PostgreSQL, pytest und Restore-Drill mangels Infrastruktur.
