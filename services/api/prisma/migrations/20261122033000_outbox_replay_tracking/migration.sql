-- Replay tracking for dead-lettered outbox events.
-- Additive and safe for existing rows: every event starts with zero replays.
ALTER TABLE "OutboxEvent" ADD COLUMN "replayCount" INTEGER NOT NULL DEFAULT 0;
