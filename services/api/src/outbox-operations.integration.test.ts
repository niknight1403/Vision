import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  outboxStatusCounts,
  processOneOutboxMessage,
  reapExpiredLeases,
  replayDeadLetter,
} from "./outbox-worker.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!databaseEnabled);

const prisma = new PrismaClient();
const aggregateIds: string[] = [];
let sequence = 0;

async function createEvent(overrides: {
  status?: "PENDING" | "PROCESSING" | "PUBLISHED" | "DEAD_LETTER";
  attempts?: number;
  leaseUntil?: Date | null;
  lockedBy?: string | null;
  replayCount?: number;
} = {}) {
  sequence += 1;
  const aggregateId = `outbox-ops-${process.pid}-${sequence}`;
  aggregateIds.push(aggregateId);
  return await prisma.outboxEvent.create({
    data: {
      eventType: "agent.task.created",
      aggregateId,
      payload: { aggregateId },
      status: overrides.status ?? "PENDING",
      attempts: overrides.attempts ?? 0,
      leaseUntil: overrides.leaseUntil ?? null,
      lockedBy: overrides.lockedBy ?? null,
      ...(overrides.replayCount === undefined ? {} : { replayCount: overrides.replayCount }),
    },
  });
}

suite("outbox operations", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });
    aggregateIds.length = 0;
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });
    await prisma.$disconnect();
  });

  it("returns an expired lease to the queue and leaves a live lease alone", async () => {
    const expired = await createEvent({
      status: "PROCESSING",
      attempts: 1,
      leaseUntil: new Date(Date.now() - 60_000),
      lockedBy: "worker-crashed",
    });
    const live = await createEvent({
      status: "PROCESSING",
      attempts: 1,
      leaseUntil: new Date(Date.now() + 60_000),
      lockedBy: "worker-alive",
    });

    const reaped = await reapExpiredLeases(prisma, { limit: 50 });
    expect(reaped).toBeGreaterThanOrEqual(1);

    const reapedRow = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: expired.id } });
    expect(reapedRow.status).toBe("PENDING");
    expect(reapedRow.lockedBy).toBeNull();
    expect(reapedRow.leaseUntil).toBeNull();
    expect(reapedRow.lastError).toBe("LEASE_EXPIRED");

    const liveRow = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: live.id } });
    expect(liveRow.status).toBe("PROCESSING");
    expect(liveRow.lockedBy).toBe("worker-alive");
  });

  it("rejects an invalid reap limit", async () => {
    await expect(reapExpiredLeases(prisma, { limit: 0 })).rejects.toThrow("INVALID_REAP_LIMIT");
    await expect(reapExpiredLeases(prisma, { limit: 5000 })).rejects.toThrow("INVALID_REAP_LIMIT");
  });

  it("reports status counts including dead letters", async () => {
    await createEvent({ status: "PENDING" });
    await createEvent({ status: "DEAD_LETTER", attempts: 8 });
    const counts = await outboxStatusCounts(prisma);
    expect(counts.PENDING).toBeGreaterThanOrEqual(1);
    expect(counts.DEAD_LETTER).toBeGreaterThanOrEqual(1);
    expect(Object.keys(counts).sort()).toEqual(["DEAD_LETTER", "PENDING", "PROCESSING", "PUBLISHED"]);
  });

  it("retries with a redacted error and then dead-letters at the attempt limit", async () => {
    const event = await createEvent();
    const options = { workerId: "worker-1", leaseSeconds: 30, maxAttempts: 2, baseRetrySeconds: 5, aggregateId: event.aggregateId };

    const first = await processOneOutboxMessage(prisma, options, async () => {
      throw new Error("handler failed for https://private.example/x token=abc123");
    });
    expect(first).toBe("RETRY_SCHEDULED");
    const afterFirst = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: aggregateIds[0]! },
    });
    expect(afterFirst.status).toBe("PENDING");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.lastError).not.toContain("abc123");
    expect(afterFirst.lastError).not.toContain("private.example");

    // Simulate the retry window having elapsed instead of waiting for the backoff.
    await prisma.outboxEvent.update({
      where: { id: afterFirst.id },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });

    const second = await processOneOutboxMessage(prisma, options, async () => {
      throw new Error("still failing");
    });
    expect(second).toBe("DEAD_LETTER");
    const afterSecond = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: aggregateIds[0]! },
    });
    expect(afterSecond.status).toBe("DEAD_LETTER");
    expect(afterSecond.leaseUntil).toBeNull();
    expect(afterSecond.lockedBy).toBeNull();
  });

  it("fails the handler when its lease was taken over (fencing)", async () => {
    const event = await createEvent();
    await expect(
      processOneOutboxMessage(prisma, { workerId: "worker-a", leaseSeconds: 30, aggregateId: event.aggregateId }, async () => {
        // Another worker wins the expired lease while this handler is running.
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: { lockedBy: "worker-b", leaseUntil: new Date(Date.now() + 30_000) },
        });
      }),
    ).rejects.toThrow("OUTBOX_LEASE_LOST");

    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.status).toBe("PROCESSING");
    expect(row.lockedBy).toBe("worker-b");
  });

  it("replays a dead letter exactly once and then refuses", async () => {
    const event = await createEvent({ status: "DEAD_LETTER", attempts: 8, replayCount: 0 });

    expect(await replayDeadLetter(prisma, event.id)).toBe("REPLAYED");
    const replayed = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(replayed.status).toBe("PENDING");
    expect(replayed.attempts).toBe(0);
    expect(replayed.replayCount).toBe(1);
    expect(replayed.lastError).toBeNull();

    expect(await replayDeadLetter(prisma, event.id)).toBe("NOT_DEAD_LETTER");
  });

  it("refuses a replay beyond the configured limit and for live events", async () => {
    const replayedOnce = await createEvent({ status: "DEAD_LETTER", attempts: 8, replayCount: 1 });
    expect(await replayDeadLetter(prisma, replayedOnce.id)).toBe("REPLAY_LIMIT_REACHED");

    const live = await createEvent({ status: "PENDING" });
    expect(await replayDeadLetter(prisma, live.id)).toBe("NOT_DEAD_LETTER");

    const allowedTwice = await createEvent({ status: "DEAD_LETTER", attempts: 8, replayCount: 1 });
    expect(await replayDeadLetter(prisma, allowedTwice.id, { maxReplays: 2 })).toBe("REPLAYED");

    await expect(replayDeadLetter(prisma, "missing-event-id")).rejects.toThrow("OUTBOX_EVENT_NOT_FOUND");
    await expect(replayDeadLetter(prisma, replayedOnce.id, { maxReplays: 0 })).rejects.toThrow("INVALID_MAX_REPLAYS");
  });
});
