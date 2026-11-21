import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { reconcileOutbox } from "./outbox-reconciliation.js";

const enabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!enabled);
const prisma = new PrismaClient();
const ids: string[] = [];

suite("outbox reconciliation (PostgreSQL)", () => {
  afterAll(async () => {
    if (ids.length) {
      await prisma.outboxConsumerReceipt.deleteMany({ where: { eventId: { in: ids } } });
      await prisma.outboxEvent.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  it("reports a missing required receipt without mutating the event", async () => {
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.reconciliation.receipt",
      aggregateId: `reconciliation-${process.pid}-${Date.now()}`,
      payload: { mustNotBeReturned: "sensitive-payload" },
      status: "PUBLISHED",
      publishedAt: new Date(),
    } });
    ids.push(event.id);

    const report = await reconcileOutbox(prisma, {
      expectedConsumers: { "test.reconciliation.receipt": ["ledger-projection"] },
    });

    expect(report.findings).toContainEqual({
      code: "REQUIRED_RECEIPT_MISSING",
      severity: "CRITICAL",
      eventId: event.id,
      eventType: "test.reconciliation.receipt",
      consumerName: "ledger-projection",
    });
    expect(JSON.stringify(report)).not.toContain("sensitive-payload");
    const unchanged = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(unchanged.status).toBe("PUBLISHED");
    expect(unchanged.publishedAt).not.toBeNull();
  });
});

if (!enabled) void prisma.$disconnect();
