# Database invariant runbook

The migration `20261121101500_wallet_testnet_invariants` is additive and fail-closed. It adds PostgreSQL checks for nonnegative wallet balances/reserves, reserves not exceeding balances, nonnegative ledger amounts, positive approval quantities/prices, nonnegative approval fee limits, and foreign keys between approval snapshots and order intents.

Before applying it, run `npx prisma migrate deploy --schema services/api/prisma/schema.prisma` against the intended PostgreSQL database. The migration performs prechecks and aborts without changing the schema when invalid rows or orphan references exist. Quarantine and reconcile those rows through an independently reviewed, auditable backfill; do not use `prisma migrate reset` on shared or production data. No production database, credentials, or successful integration evidence is claimed in this repository until the explicit PostgreSQL gate passes.
