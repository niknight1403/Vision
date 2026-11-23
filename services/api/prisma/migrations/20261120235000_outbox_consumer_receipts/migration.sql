-- Durable consumer receipts: one successful processing record per consumer and event.
CREATE TABLE "OutboxConsumerReceipt" (
    "id" TEXT NOT NULL,
    "consumerName" VARCHAR(128) NOT NULL,
    "eventId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutboxConsumerReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutboxConsumerReceipt_consumerName_eventId_key"
    ON "OutboxConsumerReceipt"("consumerName", "eventId");
CREATE INDEX "OutboxConsumerReceipt_consumerName_processedAt_idx"
    ON "OutboxConsumerReceipt"("consumerName", "processedAt");

ALTER TABLE "OutboxConsumerReceipt"
    ADD CONSTRAINT "OutboxConsumerReceipt_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "OutboxEvent"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
