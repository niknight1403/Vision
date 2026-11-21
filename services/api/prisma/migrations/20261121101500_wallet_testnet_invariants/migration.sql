-- Sprint 12: additive safety constraints only. This migration intentionally fails
-- before applying if existing rows violate the invariant; use the runbook for a
-- reviewed quarantine/backfill, never migrate reset in a shared environment.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WalletAccount" WHERE "balanceCents" < 0 OR "reservedCents" < 0 OR "reservedCents" > "balanceCents") THEN
    RAISE EXCEPTION 'WALLET_INVARIANT_PRECHECK_FAILED: quarantine invalid balances/reserves before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM "WalletLedger" WHERE "amountCents" < 0) THEN
    RAISE EXCEPTION 'WALLET_INVARIANT_PRECHECK_FAILED: quarantine negative ledger amounts before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM "ApprovalSnapshot" WHERE "quantity" <= 0 OR "limitPriceCents" <= 0 OR "feeLimitCents" < 0) THEN
    RAISE EXCEPTION 'APPROVAL_INVARIANT_PRECHECK_FAILED: quarantine invalid approval financial fields before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM "TestnetOrderIntent" WHERE "approvalId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ApprovalSnapshot" a WHERE a."id" = "TestnetOrderIntent"."approvalId")) THEN
    RAISE EXCEPTION 'APPROVAL_REFERENCE_PRECHECK_FAILED: quarantine orphan approval references before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM "ApprovalSnapshot" a WHERE NOT EXISTS (SELECT 1 FROM "TestnetOrderIntent" i WHERE i."id" = a."intentId")) THEN
    RAISE EXCEPTION 'INTENT_REFERENCE_PRECHECK_FAILED: quarantine orphan approval intents before migration';
  END IF;
END $$;

ALTER TABLE "WalletAccount"
  ADD CONSTRAINT "WalletAccount_nonnegative_balance_check" CHECK ("balanceCents" >= 0),
  ADD CONSTRAINT "WalletAccount_nonnegative_reserved_check" CHECK ("reservedCents" >= 0),
  ADD CONSTRAINT "WalletAccount_reserved_not_above_balance_check" CHECK ("reservedCents" <= "balanceCents");
ALTER TABLE "WalletLedger"
  ADD CONSTRAINT "WalletLedger_nonnegative_amount_check" CHECK ("amountCents" >= 0);
ALTER TABLE "ApprovalSnapshot"
  ADD CONSTRAINT "ApprovalSnapshot_positive_quantity_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "ApprovalSnapshot_positive_limit_price_check" CHECK ("limitPriceCents" > 0),
  ADD CONSTRAINT "ApprovalSnapshot_nonnegative_fee_limit_check" CHECK ("feeLimitCents" >= 0);
ALTER TABLE "TestnetOrderIntent"
  ADD CONSTRAINT "TestnetOrderIntent_approvalId_fkey"
  FOREIGN KEY ("approvalId") REFERENCES "ApprovalSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApprovalSnapshot"
  ADD CONSTRAINT "ApprovalSnapshot_intentId_fkey"
  FOREIGN KEY ("intentId") REFERENCES "TestnetOrderIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
