-- Contract tenant ownership after the tenant-aware API has been introduced.
-- PR #30 backfills every existing row; abort if any unscoped rows remain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WalletAccount" WHERE "tenantId" IS NULL) THEN
    RAISE EXCEPTION 'Tenant contract aborted: WalletAccount contains unscoped rows';
  END IF;
  IF EXISTS (SELECT 1 FROM "AgentTask" WHERE "tenantId" IS NULL) THEN
    RAISE EXCEPTION 'Tenant contract aborted: AgentTask contains unscoped rows';
  END IF;
END $$;

ALTER TABLE "WalletAccount" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "AgentTask" ALTER COLUMN "tenantId" SET NOT NULL;

DROP INDEX IF EXISTS "WalletAccount_ownerId_currency_key";
DROP INDEX IF EXISTS "AgentTask_idempotencyKey_key";
