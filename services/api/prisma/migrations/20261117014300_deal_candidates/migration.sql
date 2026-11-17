CREATE TYPE "DealReviewStatus" AS ENUM ('DISCOVERED', 'APPROVED', 'REJECTED', 'ARCHIVED');

CREATE TABLE "DealCandidate" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "productUrl" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "purchasePriceMinor" BIGINT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "simulated" BOOLEAN NOT NULL DEFAULT false,
  "totalCostCents" BIGINT NOT NULL,
  "expectedProfitCents" BIGINT NOT NULL,
  "roiBasisPoints" BIGINT,
  "riskPassed" BOOLEAN NOT NULL,
  "riskReasons" JSONB NOT NULL,
  "reviewStatus" "DealReviewStatus" NOT NULL DEFAULT 'DISCOVERED',
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DealCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DealCandidate_providerId_externalId_key"
  ON "DealCandidate"("providerId", "externalId");
CREATE INDEX "DealCandidate_reviewStatus_updatedAt_idx"
  ON "DealCandidate"("reviewStatus", "updatedAt");
CREATE INDEX "DealCandidate_riskPassed_expectedProfitCents_idx"
  ON "DealCandidate"("riskPassed", "expectedProfitCents");
CREATE INDEX "DealCandidate_observedAt_idx"
  ON "DealCandidate"("observedAt");
