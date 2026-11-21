-- Scope wallet ledger idempotency and reservation references to their wallet account.
-- Drop the dependent self-FK before replacing its referenced unique index.
ALTER TABLE "WalletLedger"
  DROP CONSTRAINT IF EXISTS "WalletLedger_reservationReferenceId_fkey";

ALTER TABLE "WalletLedger"
  DROP CONSTRAINT IF EXISTS "WalletLedger_referenceId_key";

DROP INDEX IF EXISTS "WalletLedger_referenceId_key";

CREATE UNIQUE INDEX "WalletLedger_accountId_referenceId_key"
  ON "WalletLedger"("accountId", "referenceId");

ALTER TABLE "WalletLedger"
  ADD CONSTRAINT "WalletLedger_accountId_reservationReferenceId_fkey"
  FOREIGN KEY ("accountId", "reservationReferenceId")
  REFERENCES "WalletLedger"("accountId", "referenceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
