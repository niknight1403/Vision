ALTER TABLE "AgentTask"
  ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "AgentTask_status_availableAt_idx"
  ON "AgentTask"("status", "availableAt");
