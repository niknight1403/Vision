CREATE TYPE "TestnetKillSwitchScope" AS ENUM ('GLOBAL', 'PROVIDER', 'ACCOUNT', 'STRATEGY');
CREATE TYPE "TestnetKillSwitchState" AS ENUM ('ARMED', 'TRIGGERED', 'DRAINING', 'HALTED');
CREATE TYPE "TestnetOrderStatus" AS ENUM ('DRAFT', 'APPROVED', 'QUEUED', 'SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED', 'UNKNOWN');
CREATE TYPE "ReconciliationStatus" AS ENUM ('RUNNING', 'CLEAN', 'HALT_REQUIRED', 'FAILED');

CREATE TABLE "TestnetKillSwitch" (
    "id" TEXT NOT NULL,
    "scope" "TestnetKillSwitchScope" NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "state" "TestnetKillSwitchState" NOT NULL DEFAULT 'ARMED',
    "reason" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TestnetKillSwitch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TestnetKillSwitch_scope_scopeKey_key" ON "TestnetKillSwitch"("scope", "scopeKey");
CREATE INDEX "TestnetKillSwitch_state_updatedAt_idx" ON "TestnetKillSwitch"("state", "updatedAt");

CREATE TABLE "ApprovalSnapshot" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'TESTNET',
    "providerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "limitPriceCents" BIGINT NOT NULL,
    "feeLimitCents" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApprovalSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApprovalSnapshot_intentId_key" ON "ApprovalSnapshot"("intentId");
CREATE INDEX "ApprovalSnapshot_environment_providerId_accountId_idx" ON "ApprovalSnapshot"("environment", "providerId", "accountId");
CREATE INDEX "ApprovalSnapshot_expiresAt_idx" ON "ApprovalSnapshot"("expiresAt");

CREATE TABLE "TestnetOrderIntent" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'TESTNET',
    "providerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" "TestnetOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "clientOrderId" TEXT NOT NULL,
    "approvalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TestnetOrderIntent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TestnetOrderIntent_idempotencyKey_key" ON "TestnetOrderIntent"("idempotencyKey");
CREATE UNIQUE INDEX "TestnetOrderIntent_clientOrderId_key" ON "TestnetOrderIntent"("clientOrderId");
CREATE UNIQUE INDEX "TestnetOrderIntent_approvalId_key" ON "TestnetOrderIntent"("approvalId");
CREATE INDEX "TestnetOrderIntent_environment_providerId_accountId_status_idx" ON "TestnetOrderIntent"("environment", "providerId", "accountId", "status");
CREATE INDEX "TestnetOrderIntent_status_updatedAt_idx" ON "TestnetOrderIntent"("status", "updatedAt");

CREATE TABLE "TestnetOrderEvent" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TestnetOrderEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TestnetOrderEvent_intentId_createdAt_idx" ON "TestnetOrderEvent"("intentId", "createdAt");
CREATE UNIQUE INDEX "TestnetOrderEvent_intentId_eventType_payloadHash_key" ON "TestnetOrderEvent"("intentId", "eventType", "payloadHash");

CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'TESTNET',
    "providerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'RUNNING',
    "watermark" TEXT,
    "diffSummary" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReconciliationRun_providerId_accountId_startedAt_idx" ON "ReconciliationRun"("providerId", "accountId", "startedAt");
CREATE INDEX "ReconciliationRun_status_startedAt_idx" ON "ReconciliationRun"("status", "startedAt");
