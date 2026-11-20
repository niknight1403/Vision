-- Expand/backfill tenant ownership without assigning shared catalogue rows to tenants.
-- Abort on orphaned ownership rather than inventing a fallback tenant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WalletAccount" w LEFT JOIN "User" u ON u.id = w."ownerId" WHERE u.id IS NULL) THEN
    RAISE EXCEPTION 'Tenant migration aborted: WalletAccount contains ownerId values without a User';
  END IF;
  IF EXISTS (SELECT 1 FROM "AgentTask" t LEFT JOIN "User" u ON u.id = t."ownerId" WHERE u.id IS NULL) THEN
    RAISE EXCEPTION 'Tenant migration aborted: AgentTask contains ownerId values without a User';
  END IF;
END $$;

CREATE TYPE "TenantRole" AS ENUM ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER');
CREATE TYPE "TenantReviewDecision" AS ENUM ('APPROVED', 'REJECTED', 'ARCHIVED');

CREATE TABLE "Tenant" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantMembership" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "TenantRole" NOT NULL DEFAULT 'VIEWER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantMembership_pkey" PRIMARY KEY ("id")
);

-- Deterministic personal tenant for each existing user; no email-domain inference.
INSERT INTO "Tenant" ("id", "name", "updatedAt")
SELECT 'personal_' || u.id, 'Personal workspace', CURRENT_TIMESTAMP FROM "User" u;

INSERT INTO "TenantMembership" ("id", "tenantId", "userId", "role", "updatedAt")
SELECT 'membership_' || u.id, 'personal_' || u.id, u.id,
       CASE WHEN u.role = 'ADMIN' THEN 'OWNER'::"TenantRole" ELSE 'OWNER'::"TenantRole" END,
       CURRENT_TIMESTAMP
FROM "User" u;

ALTER TABLE "WalletAccount" ADD COLUMN "tenantId" TEXT;
UPDATE "WalletAccount" w SET "tenantId" = 'personal_' || w."ownerId";
ALTER TABLE "WalletAccount" ALTER COLUMN "tenantId" SET NOT NULL;

ALTER TABLE "AgentTask" ADD COLUMN "tenantId" TEXT;
UPDATE "AgentTask" t SET "tenantId" = 'personal_' || t."ownerId";
ALTER TABLE "AgentTask" ALTER COLUMN "tenantId" SET NOT NULL;

-- Preserve historical global review state as evidence; never convert it to tenant approvals.
CREATE TABLE "LegacyDealReviewState" (
  "candidateId" TEXT NOT NULL,
  "reviewStatus" "DealReviewStatus" NOT NULL,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LegacyDealReviewState_pkey" PRIMARY KEY ("candidateId")
);
INSERT INTO "LegacyDealReviewState" ("candidateId", "reviewStatus", "reviewedBy", "reviewedAt")
SELECT "id", "reviewStatus", "reviewedBy", "reviewedAt" FROM "DealCandidate";

CREATE TABLE "DealReview" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "reviewerUserId" TEXT NOT NULL,
  "decision" "TenantReviewDecision" NOT NULL,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DealReview_pkey" PRIMARY KEY ("id")
);

DROP INDEX "WalletAccount_ownerId_currency_key";
CREATE UNIQUE INDEX "WalletAccount_tenantId_ownerId_currency_key" ON "WalletAccount"("tenantId", "ownerId", "currency");
CREATE INDEX "WalletAccount_tenantId_createdAt_idx" ON "WalletAccount"("tenantId", "createdAt");

DROP INDEX "AgentTask_idempotencyKey_key";
CREATE UNIQUE INDEX "AgentTask_tenantId_idempotencyKey_key" ON "AgentTask"("tenantId", "idempotencyKey");
CREATE INDEX "AgentTask_tenantId_createdAt_idx" ON "AgentTask"("tenantId", "createdAt");

CREATE UNIQUE INDEX "TenantMembership_tenantId_userId_key" ON "TenantMembership"("tenantId", "userId");
CREATE INDEX "TenantMembership_userId_role_idx" ON "TenantMembership"("userId", "role");
CREATE UNIQUE INDEX "DealReview_tenantId_candidateId_key" ON "DealReview"("tenantId", "candidateId");
CREATE INDEX "DealReview_tenantId_decision_reviewedAt_idx" ON "DealReview"("tenantId", "decision", "reviewedAt");
CREATE INDEX "DealReview_reviewerUserId_reviewedAt_idx" ON "DealReview"("reviewerUserId", "reviewedAt");

ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalletAccount" ADD CONSTRAINT "WalletAccount_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealReview" ADD CONSTRAINT "DealReview_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DealReview" ADD CONSTRAINT "DealReview_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "DealCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
