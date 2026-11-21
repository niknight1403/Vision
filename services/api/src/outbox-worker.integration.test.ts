import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { processOneOutboxMessage, processOneOutboxMessageWithInbox } from "./outbox-worker.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!databaseEnabled);
const prisma = new PrismaClient();

suite("outbox worker lease safety (PostgreSQL)", () => {
  const aggregateIds: string[] = [];

  afterAll(async () => {
    if (aggregateIds.length) {
      const events = await prisma.outboxEvent.findMany({ where: { aggregateId: { in: aggregateIds } }, select: { id: true } });
      if (events.length) await prisma.outboxConsumerReceipt.deleteMany({ where: { eventId: { in: events.map((event) => event.id) } } });
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });
    }
    await prisma.$disconnect();
  });

  it("processes database effects through the inbox before acknowledging the outbox event", async () => {
    const aggregateId = `outbox-inbox-success-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.inbox.worker", aggregateId, payload: { test: true },
    } });
    const result = await processOneOutboxMessageWithInbox(
      prisma,
      { workerId: "worker-inbox", eventTypes: ["test.inbox.worker"] },
      "integration-projection",
      async (tx, message) => {
        await tx.idempotencyKey.create({ data: {
          scope: `worker-inbox-${message.id}`, key: "projection",
          requestHash: "d".repeat(64), expiresAt: new Date(Date.now() + 60_000),
        } });
      },
    );
    expect(result).toBe("PUBLISHED");
    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("PUBLISHED");
    expect(await prisma.outboxConsumerReceipt.count({
      where: { eventId: event.id, consumerName: "integration-projection" },
    })).toBe(1);
    expect(await prisma.idempotencyKey.count({ where: { scope: `worker-inbox-${event.id}` } })).toBe(1);
    await prisma.idempotencyKey.deleteMany({ where: { scope: `worker-inbox-${event.id}` } });
  });

  it("acknowledges redelivery without repeating effects when a receipt already exists", async () => {
    const aggregateId = `outbox-inbox-redelivery-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.inbox.worker.redelivery", aggregateId, payload: { test: true },
    } });
    await prisma.outboxConsumerReceipt.create({ data: {
      consumerName: "integration-redelivery", eventId: event.id,
    } });
    const handler = async () => { throw new Error("DUPLICATE_HANDLER_MUST_NOT_RUN"); };
    const result = await processOneOutboxMessageWithInbox(
      prisma,
      { workerId: "worker-redelivery", eventTypes: ["test.inbox.worker.redelivery"] },
      "integration-redelivery",
      handler,
    );
    expect(result).toBe("PUBLISHED");
    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("PUBLISHED");
    expect(current.attempts).toBe(1);
    expect(await prisma.outboxConsumerReceipt.count({
      where: { eventId: event.id, consumerName: "integration-redelivery" },
    })).toBe(1);
  });

  it("does not acknowledge or retain a receipt when an inbox consumer transaction fails", async () => {
    const aggregateId = `outbox-inbox-failure-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.inbox.worker.failure", aggregateId, payload: { test: true },
    } });
    const result = await processOneOutboxMessageWithInbox(
      prisma,
      { workerId: "worker-inbox-failure", maxAttempts: 2, baseRetrySeconds: 5, eventTypes: ["test.inbox.worker.failure"] },
      "integration-projection-failure",
      async () => { throw new Error("transactional consumer failure"); },
    );
    expect(result).toBe("RETRY_SCHEDULED");
    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("PENDING");
    expect(current.lockedBy).toBeNull();
    expect(await prisma.outboxConsumerReceipt.count({ where: { eventId: event.id } })).toBe(0);
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
      { workerId: "worker-one", leaseSeconds: 30, eventTypes: ["test.lease.race"] },
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
      { workerId: "worker-retry", baseRetrySeconds: 5, eventTypes: ["test.retry"] },
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
  it("moves exhausted messages to dead letter and clears the lease", async () => {
    const aggregateId = `outbox-dead-letter-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({
      data: {
        eventType: "test.dead-letter",
        aggregateId,
        payload: { test: true },
      },
    });

    const result = await processOneOutboxMessage(
      prisma,
      { workerId: "worker-dead-letter", maxAttempts: 1, eventTypes: ["test.dead-letter"] },
      async () => { throw new Error("permanent downstream rejection"); },
    );
    expect(result).toBe("DEAD_LETTER");

    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("DEAD_LETTER");
    expect(current.lockedBy).toBeNull();
    expect(current.leaseUntil).toBeNull();
    expect(current.lastError).toBe("permanent downstream rejection");
    expect(current.attempts).toBe(1);
  });


  it("dead-letters an exhausted inbox consumer failure without retaining its receipt or credentials", async () => {
    const aggregateId = `outbox-inbox-dead-letter-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.inbox.worker.dead-letter", aggregateId, payload: { test: true },
    } });
    const result = await processOneOutboxMessageWithInbox(
      prisma,
      { workerId: "worker-inbox-dead-letter", maxAttempts: 1, eventTypes: ["test.inbox.worker.dead-letter"] },
      "integration-dead-letter",
      async () => { throw new Error("Authorization: Bearer test-token-123 api_key=sk-test-secret"); },
    );
    expect(result).toBe("DEAD_LETTER");
    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("DEAD_LETTER");
    expect(current.lockedBy).toBeNull();
    expect(current.leaseUntil).toBeNull();
    expect(current.lastError).toContain("Bearer [REDACTED]");
    expect(current.lastError).toContain("api_key=[REDACTED]");
    expect(current.lastError).not.toContain("test-token-123");
    expect(current.lastError).not.toContain("sk-test-secret");
    expect(await prisma.outboxConsumerReceipt.count({ where: { eventId: event.id } })).toBe(0);
  });

});

if (!databaseEnabled) {
  void prisma.$disconnect();
}
