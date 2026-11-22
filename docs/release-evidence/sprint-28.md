# Sprint 28 — Prisma-/DB-Schema-Konsistenz

**Nachweis:** `services/api/prisma/schema.prisma`, `services/api/prisma/migrations/20261117015000_testnet_safety/migration.sql`, `services/api/prisma/migrations/20261121101500_wallet_testnet_invariants/migration.sql`, `docs/database-invariants-runbook.md`.

ApprovalSnapshot und TestnetOrderIntent sind beidseitig modelliert und durch additive, restriktive Foreign Keys verbunden. Wallet-/Ledger-Checks verwenden Preflight-Abbruch statt destruktiver Trigger oder Reset.

**Checks:** `prisma validate` bestanden; `git diff --check` bestanden. **Offen:** kein Datenbank-Migrate-Deploy ohne PostgreSQL.
