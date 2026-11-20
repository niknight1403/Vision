-- Establish tenant boundaries without guessing ownership of the shared deal catalog.
-- Every existing user receives a personal tenant. Existing deal observations remain shared.
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantMembership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantMembership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DealReviewDecision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealCandidateId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "DealReviewStatus" NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DealReviewDecision_pkey" PRIMARY KEY ("id")
);

-- Deterministic personal-workspace backfill. No shared deal is assigned to a user.
INSERT INTO "Tenant" ("id", "name", "createdAt", "updatedAt")
SELECT 'legacy-personal-' || "id", 'Personal workspace', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "User";

INSERT INTO "TenantMembership" ("id", "tenantId", "userId", "role", "createdAt")
SELECT 'legacy-membership-' || "id", 'legacy-personal-' || "id", "id", "role", CURRENT_TIMESTAMP
FROM "User";

CREATE UNIQUE INDEX "TenantMembership_tenantId_userId_key" ON "TenantMembership"("tenantId", "userId");
CREATE INDEX "TenantMembership_userId_createdAt_idx" ON "TenantMembership"("userId", "createdAt");
CREATE UNIQUE INDEX "DealReviewDecision_tenantId_dealCandidateId_key" ON "DealReviewDecision"("tenantId", "dealCandidateId");
CREATE INDEX "DealReviewDecision_tenantId_decision_reviewedAt_idx" ON "DealReviewDecision"("tenantId", "decision", "reviewedAt");
CREATE INDEX "DealReviewDecision_reviewerId_reviewedAt_idx" ON "DealReviewDecision"("reviewerId", "reviewedAt");

ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DealReviewDecision" ADD CONSTRAINT "DealReviewDecision_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DealReviewDecision" ADD CONSTRAINT "DealReviewDecision_dealCandidateId_fkey"
FOREIGN KEY ("dealCandidateId") REFERENCES "DealCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DealReviewDecision" ADD CONSTRAINT "DealReviewDecision_reviewerId_fkey"
FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
