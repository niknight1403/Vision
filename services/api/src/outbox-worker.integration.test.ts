import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { processOneOutboxMessage } from "./outbox-worker.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!databaseEnabled);
const prisma = new PrismaClient();

suite("outbox worker lease safety (PostgreSQL)", () => {
  const aggregateIds: string[] = [];

  afterAll(async () => {
    if (aggregateIds.length) {
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });
    }
    await prisma.$disconnect();
  });

  it("does not overwrite a message reclaimed by another worker", async () => {
    const aggregateId = `outbox-lease-race-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({
      data: {
        eventType: "test.lease.race",
        aggregateId,
        payload: { test: true },
      },
    });

    await expect(processOneOutboxMessage(
      prisma,
      { workerId: "worker-one", leaseSeconds: 30 },
      async (message) => {
        await prisma.outboxEvent.updateMany({
          where: { id: message.id, status: "PROCESSING", lockedBy: "worker-one" },
          data: {
            lockedBy: "worker-two",
            leaseUntil: new Date(Date.now() + 60_000),
          },
        });
        throw new Error("simulated handler failure after lease takeover");
      },
    )).rejects.toThrow("OUTBOX_LEASE_LOST");

    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("PROCESSING");
    expect(current.lockedBy).toBe("worker-two");
    expect(current.lastError).toBeNull();
    expect(current.attempts).toBe(1);
  });

  it("releases its own failed lease and schedules a retry", async () => {
    const aggregateId = `outbox-retry-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({
      data: {
        eventType: "test.retry",
        aggregateId,
        payload: { test: true },
      },
    });

    const result = await processOneOutboxMessage(
      prisma,
      { workerId: "worker-retry", baseRetrySeconds: 5 },
      async () => { throw new Error("temporary downstream outage"); },
    );
    expect(result).toBe("RETRY_SCHEDULED");

    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("PENDING");
    expect(current.lockedBy).toBeNull();
    expect(current.leaseUntil).toBeNull();
    expect(current.lastError).toBe("temporary downstream outage");
    expect(current.attempts).toBe(1);
    expect(current.availableAt.getTime()).toBeGreaterThan(Date.now());
  });
});

if (!databaseEnabled) {
  void prisma.$disconnect();
}
