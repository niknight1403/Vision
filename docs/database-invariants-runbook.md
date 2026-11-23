# Database invariant runbook

The migration `20261121101500_wallet_testnet_invariants` is additive and fail-closed. It adds PostgreSQL checks for nonnegative wallet balances/reserves, reserves not exceeding balances, nonnegative ledger amounts, positive approval quantities/prices, nonnegative approval fee limits, and foreign keys between approval snapshots and order intents.

Before applying it, run `npx prisma migrate deploy --schema services/api/prisma/schema.prisma` against the intended PostgreSQL database. The migration performs prechecks and aborts without changing the schema when invalid rows or orphan references exist. Quarantine and reconcile those rows through an independently reviewed, auditable backfill; do not use `prisma migrate reset` on shared or production data. No production database, credentials, or successful integration evidence is claimed in this repository until the explicit PostgreSQL gate passes.

## Local integration evidence (Sprint 32)

`scripts/local-postgres.sh` prepares a throwaway cluster (default `PG_DATA=/tmp/autonomagent-pg/data`, port 5432) and prints the matching `DATABASE_URL`. It is idempotent: an already running cluster is reused, the role password is applied over the local socket (never as a process argument), and the database is created only when missing. `scripts/local-postgres.sh stop` shuts it down again.

Verified sequence against a freshly initialised cluster:

```bash
scripts/local-postgres.sh
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/autonomagent_test?schema=public"
npx prisma migrate deploy --schema services/api/prisma/schema.prisma
npm run test:db --workspace @autonomagent/api
```

The gate fails closed without `DATABASE_URL`, and `scripts/verify-db-integration.mjs` fails the run when any of the three integration suites is missing or skipped. Sprint 32 also fixed the `test:db` filter: the script passed the literal glob `src/**/*.integration.test.ts` to vitest, which treats positional arguments as substring filters, so the suite reported "No test files found" and had never executed. The filter is now `integration.test`.

A separate `DATABASE_URL` pointing at a shared or production database must never be used for this drill.

## Backup and restore (Sprint 38)

`scripts/backup-restore-drill.mjs` dumps the database, restores it into a scratch database, and compares the table list, per-table row counts, and the applied `_prisma_migrations` list before dropping the scratch database again. Run it after `prisma migrate deploy` against a database that actually contains rows; the integration suite cleans up after itself, so seed rows are required for a meaningful comparison. Call it with `DATABASE_URL=… node scripts/backup-restore-drill.mjs` and check the exit code (`0` pass, `1` mismatch, `2` configuration). `DRILL_KEEP=1` keeps the dump and the scratch database for inspection. The full operating procedure, including a real restore into a staging/production database and its limits (no PITR, no offsite storage, no encryption proof), is in [runbooks/backup-restore.md](runbooks/backup-restore.md).
