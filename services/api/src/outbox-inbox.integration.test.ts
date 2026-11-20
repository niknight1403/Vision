import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { processOutboxEventInTransaction } from "./outbox-inbox.js";
import type { OutboxMessage } from "./outbox-worker.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!databaseEnabled);
const prisma = new PrismaClient();
const eventIds: string[] = [];
const scopes: string[] = [];

suite("transactional outbox consumer inbox (PostgreSQL)", () => {
  afterAll(async () => {
    if (eventIds.length) {
      await prisma.outboxConsumerReceipt.deleteMany({ where: { eventId: { in: eventIds } } });
      await prisma.outboxEvent.deleteMany({ where: { id: { in: eventIds } } });
    }
    if (scopes.length) await prisma.idempotencyKey.deleteMany({ where: { scope: { in: scopes } } });
    await prisma.$disconnect();
  });

  async function createMessage(eventType: string): Promise<OutboxMessage> {
    const event = await prisma.outboxEvent.create({ data: {
      eventType, aggregateId: `inbox-test-${process.pid}-${Date.now()}-${eventIds.length}`, payload: { test: true },
    } });
    eventIds.push(event.id);
    return {
      id: event.id, eventType: event.eventType, aggregateId: event.aggregateId,
      correlationId: event.correlationId, schemaVersion: event.schemaVersion,
      payload: event.payload, attempts: event.attempts,
    };
  }

  it("deduplicates repeated delivery for one consumer but allows another consumer", async () => {
    const message = await createMessage("test.inbox.dedupe");
    const scope = `inbox-effect-${message.id}`;
    scopes.push(scope);
    const handler = async (tx: Parameters<typeof processOutboxEventInTransaction>[0]) => {
      await tx.idempotencyKey.create({ data: {
        scope, key: "effect", requestHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000),
      } });
    };

    const first = await prisma.$transaction((tx) =>
      processOutboxEventInTransaction(tx, "billing-projection", message, handler));
    const retry = await prisma.$transaction((tx) =>
      processOutboxEventInTransaction(tx, "billing-projection", message, handler));
    const independent = await prisma.$transaction((tx) =>
      processOutboxEventInTransaction(tx, "audit-projection", message, async () => undefined));

    expect(first).toBe("PROCESSED");
    expect(retry).toBe("DUPLICATE");
    expect(independent).toBe("PROCESSED");
    expect(await prisma.idempotencyKey.count({ where: { scope } })).toBe(1);
    expect(await prisma.outboxConsumerReceipt.count({ where: { eventId: message.id } })).toBe(2);
  });

  it("rolls back the receipt when the consumer transaction fails, allowing safe retry", async () => {
    const message = await createMessage("test.inbox.rollback");
    const scope = `inbox-rollback-${message.id}`;
    scopes.push(scope);
    await expect(prisma.$transaction(async (tx) => {
      await processOutboxEventInTransaction(tx, "projection", message, async (innerTx) => {
        await innerTx.idempotencyKey.create({ data: {
          scope, key: "effect", requestHash: "b".repeat(64), expiresAt: new Date(Date.now() + 60_000),
        } });
        throw new Error("FORCE_CONSUMER_ROLLBACK");
      });
    })).rejects.toThrow("FORCE_CONSUMER_ROLLBACK");

    expect(await prisma.outboxConsumerReceipt.count({ where: { eventId: message.id } })).toBe(0);
    expect(await prisma.idempotencyKey.count({ where: { scope } })).toBe(0);
    const retry = await prisma.$transaction((tx) =>
      processOutboxEventInTransaction(tx, "projection", message, async (innerTx) => {
        await innerTx.idempotencyKey.create({ data: {
          scope, key: "effect", requestHash: "b".repeat(64), expiresAt: new Date(Date.now() + 60_000),
        } });
      }));
    expect(retry).toBe("PROCESSED");
    expect(await prisma.outboxConsumerReceipt.count({ where: { eventId: message.id } })).toBe(1);
    expect(await prisma.idempotencyKey.count({ where: { scope } })).toBe(1);
  });
});

if (!databaseEnabled) void prisma.$disconnect();
