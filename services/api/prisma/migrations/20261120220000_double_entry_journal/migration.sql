-- Additive tenant-scoped immutable double-entry journal.
CREATE TABLE "JournalTransaction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "description" TEXT NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JournalTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountCode" VARCHAR(64) NOT NULL,
    "debitCents" BIGINT NOT NULL DEFAULT 0,
    "creditCents" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JournalEntry_one_sided_amount_check"
      CHECK (("debitCents" > 0 AND "creditCents" = 0) OR ("creditCents" > 0 AND "debitCents" = 0))
);

CREATE UNIQUE INDEX "JournalTransaction_tenantId_referenceId_key"
  ON "JournalTransaction"("tenantId", "referenceId");
CREATE INDEX "JournalTransaction_tenantId_createdAt_idx"
  ON "JournalTransaction"("tenantId", "createdAt");
CREATE INDEX "JournalEntry_transactionId_idx" ON "JournalEntry"("transactionId");
CREATE INDEX "JournalEntry_accountCode_createdAt_idx" ON "JournalEntry"("accountCode", "createdAt");

ALTER TABLE "JournalTransaction"
  ADD CONSTRAINT "JournalTransaction_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JournalEntry"
  ADD CONSTRAINT "JournalEntry_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "JournalTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
