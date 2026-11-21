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

  it("rejects limits outside the supported bounded range", async () => {
    await expect(reconcileOutbox(prisma, { limit: 0 })).rejects.toThrow("INVALID_RECONCILIATION_LIMIT");
    await expect(reconcileOutbox(prisma, { limit: -1 })).rejects.toThrow("INVALID_RECONCILIATION_LIMIT");
    await expect(reconcileOutbox(prisma, { limit: 1.5 })).rejects.toThrow("INVALID_RECONCILIATION_LIMIT");
    await expect(reconcileOutbox(prisma, { limit: 10_001 })).rejects.toThrow("INVALID_RECONCILIATION_LIMIT");
    await expect(reconcileOutbox(prisma, { limit: 10_000 })).resolves.toEqual(expect.objectContaining({ scanned: expect.any(Number) }));
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

  it("does not report a required receipt when the consumer receipt exists", async () => {
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.reconciliation.receipt.present",
      aggregateId: `reconciliation-receipt-present-${process.pid}-${Date.now()}`,
      payload: { marker: "receipt-present" },
      status: "PUBLISHED",
      publishedAt: new Date(),
    } });
    ids.push(event.id);
    await prisma.outboxConsumerReceipt.create({ data: {
      eventId: event.id,
      consumerName: "ledger-projection",
    } });

    const report = await reconcileOutbox(prisma, {
      expectedConsumers: { "test.reconciliation.receipt.present": ["ledger-projection"] },
    });

    expect(report.findings).not.toContainEqual(expect.objectContaining({
      code: "REQUIRED_RECEIPT_MISSING",
      eventId: event.id,
      consumerName: "ledger-projection",
    }));
    expect(report.findings.some((finding) => finding.eventId === event.id)).toBe(false);
    const receipt = await prisma.outboxConsumerReceipt.findUniqueOrThrow({
      where: { consumerName_eventId: { consumerName: "ledger-projection", eventId: event.id } },
    });
    expect(receipt.eventId).toBe(event.id);
    expect(receipt.consumerName).toBe("ledger-projection");
  });


  it("deduplicates repeated required consumers through PostgreSQL reconciliation", async () => {
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.reconciliation.consumer.dedup",
      aggregateId: `reconciliation-consumer-dedup-${process.pid}-${Date.now()}`,
      payload: { marker: "dedup-fixture" },
      status: "PUBLISHED",
      publishedAt: new Date(),
    } });
    ids.push(event.id);

    const report = await reconcileOutbox(prisma, {
      expectedConsumers: {
        "test.reconciliation.consumer.dedup": [
          "ledger-projection", "ledger-projection", "audit",
        ],
      },
    });

    const findings = report.findings.filter((finding) =>
      finding.eventId === event.id && finding.code === "REQUIRED_RECEIPT_MISSING");
    expect(findings).toEqual([
      {
        code: "REQUIRED_RECEIPT_MISSING",
        severity: "CRITICAL",
        eventId: event.id,
        eventType: "test.reconciliation.consumer.dedup",
        consumerName: "audit",
      },
      {
        code: "REQUIRED_RECEIPT_MISSING",
        severity: "CRITICAL",
        eventId: event.id,
        eventType: "test.reconciliation.consumer.dedup",
        consumerName: "ledger-projection",
      },
    ]);
    expect(report.findings.some((finding) => finding.eventId === event.id &&
      finding.code === "PUBLISHED_TIMESTAMP_MISSING")).toBe(false);
  });


  it("honors an existing receipt when required-consumer configuration contains duplicates", async () => {
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.reconciliation.consumer.dedup.receipt",
      aggregateId: `reconciliation-consumer-dedup-receipt-${process.pid}-${Date.now()}`,
      payload: { marker: "dedup-receipt-fixture" },
      status: "PUBLISHED",
      publishedAt: new Date(),
    } });
    ids.push(event.id);
    await prisma.outboxConsumerReceipt.create({ data: {
      eventId: event.id,
      consumerName: "ledger-projection",
    } });

    const report = await reconcileOutbox(prisma, {
      expectedConsumers: {
        "test.reconciliation.consumer.dedup.receipt": [
          "ledger-projection", "ledger-projection", "audit",
        ],
      },
    });

    const findings = report.findings.filter((finding) =>
      finding.eventId === event.id && finding.code === "REQUIRED_RECEIPT_MISSING");
    expect(findings).toEqual([{
      code: "REQUIRED_RECEIPT_MISSING",
      severity: "CRITICAL",
      eventId: event.id,
      eventType: "test.reconciliation.consumer.dedup.receipt",
      consumerName: "audit",
    }]);
    const receipt = await prisma.outboxConsumerReceipt.findUniqueOrThrow({
      where: { consumerName_eventId: { consumerName: "ledger-projection", eventId: event.id } },
    });
    expect(receipt.eventId).toBe(event.id);
  });

  it("applies since and limit deterministically and leaves selected events unchanged", async () => {
    const createdAt = new Date(Date.now() + 5_000);
    const fixtures = await prisma.outboxEvent.createManyAndReturn({
      data: [
        {
          eventType: "test.reconciliation.window",
          aggregateId: `reconciliation-window-a-${process.pid}-${Date.now()}`,
          payload: { marker: "first" }, status: "PUBLISHED", publishedAt: null, createdAt,
          availableAt: createdAt,
        },
        {
          eventType: "test.reconciliation.window",
          aggregateId: `reconciliation-window-b-${process.pid}-${Date.now()}`,
          payload: { marker: "second" }, status: "PUBLISHED", publishedAt: null, createdAt,
          availableAt: createdAt,
        },
      ],
    });
    ids.push(...fixtures.map((item) => item.id));
    const ordered = [...fixtures].sort((a, b) => a.id.localeCompare(b.id));
    const before = await prisma.outboxEvent.findMany({
      where: { id: { in: ids } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    const limited = await reconcileOutbox(prisma, {
      since: createdAt, limit: 1, now: createdAt,
    });
    expect(limited.scanned).toBe(1);
    expect(limited.findings).toEqual([expect.objectContaining({ code: "PUBLISHED_TIMESTAMP_MISSING", eventId: ordered[0].id })]);

    const complete = await reconcileOutbox(prisma, {
      since: createdAt, limit: 2, now: createdAt,
      expectedConsumers: { "test.reconciliation.window": ["consumer-z", "consumer-a"] },
    });
    expect(complete.scanned).toBe(2);
    expect(complete.findings.map(({ eventId, code, consumerName }) => [
      eventId, code, consumerName ?? null,
    ])).toEqual(ordered.flatMap((item) => [
      [item.id, "PUBLISHED_TIMESTAMP_MISSING", null],
      [item.id, "REQUIRED_RECEIPT_MISSING", "consumer-a"],
      [item.id, "REQUIRED_RECEIPT_MISSING", "consumer-z"],
    ]));
    const after = await prisma.outboxEvent.findMany({
      where: { id: { in: ids } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(after).toEqual(before);
    expect(ordered).toHaveLength(2);
    expect(JSON.stringify(complete)).not.toContain("first");
    expect(JSON.stringify(complete)).not.toContain("second");
  });
});

if (!enabled) void prisma.$disconnect();
