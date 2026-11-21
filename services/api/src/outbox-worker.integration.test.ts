import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { claimOutboxMessage, processOneOutboxMessage, processOneOutboxMessageWithInbox, runOutboxWorker } from "./outbox-worker.js";

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


  it("allows only one concurrent claimant to recover an expired processing lease", async () => {
    const aggregateId = `outbox-expired-lease-race-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.lease.expired-race",
      aggregateId,
      payload: { test: true },
      status: "PROCESSING",
      attempts: 4,
      lockedBy: "previous-worker-attempt",
      leaseUntil: new Date(Date.now() - 60_000),
    } });

    const [firstClaim, secondClaim] = await Promise.all([
      claimOutboxMessage(prisma, {
        workerId: "expired-race-worker-one",
        eventTypes: ["test.lease.expired-race"],
      }),
      claimOutboxMessage(prisma, {
        workerId: "expired-race-worker-two",
        eventTypes: ["test.lease.expired-race"],
      }),
    ]);

    expect(Boolean(firstClaim)).not.toBe(Boolean(secondClaim));
    const winningClaim = firstClaim ?? secondClaim;
    expect(winningClaim).not.toBeNull();

    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("PROCESSING");
    expect(current.attempts).toBe(5);
    expect(current.lockedBy).toBe(winningClaim!.claimToken);
    expect(current.leaseUntil?.getTime()).toBeGreaterThan(Date.now());
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
          where: { id: message.id, status: "PROCESSING" },
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


  it("fences a stale worker when the same worker id reclaims an expired lease", async () => {
    const aggregateId = `outbox-same-worker-fencing-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.lease.same-worker-fencing",
      aggregateId,
      payload: { test: true },
    } });

    let signalFirstEntered!: () => void;
    let signalSecondEntered!: () => void;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstEntered = new Promise<void>((resolve) => { signalFirstEntered = resolve; });
    const secondEntered = new Promise<void>((resolve) => { signalSecondEntered = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const options = {
      workerId: "worker-reused-id",
      leaseSeconds: 30,
      eventTypes: ["test.lease.same-worker-fencing"],
    };

    const firstWorker = processOneOutboxMessage(prisma, options, async () => {
      signalFirstEntered();
      await firstGate;
    });
    let secondWorker: ReturnType<typeof processOneOutboxMessage> | undefined;

    try {
      await firstEntered;
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, status: "PROCESSING" },
        data: { leaseUntil: new Date(Date.now() - 1_000) },
      });

      secondWorker = processOneOutboxMessage(prisma, options, async () => {
        signalSecondEntered();
        await secondGate;
      });
      await secondEntered;

      releaseFirst();
      await expect(firstWorker).rejects.toThrow("OUTBOX_LEASE_LOST");

      const reclaimed = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(reclaimed.status).toBe("PROCESSING");
      expect(reclaimed.attempts).toBe(2);
      expect(reclaimed.lockedBy).toContain("worker-reused-id:");
      expect(reclaimed.leaseUntil?.getTime()).toBeGreaterThan(Date.now());

      releaseSecond();
      expect(await secondWorker).toBe("PUBLISHED");
    } finally {
      releaseFirst();
      releaseSecond();
      await firstWorker.catch(() => undefined);
      if (secondWorker) await secondWorker.catch(() => undefined);
    }

    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("PUBLISHED");
    expect(current.attempts).toBe(2);
    expect(current.lockedBy).toBeNull();
    expect(current.leaseUntil).toBeNull();
  });


  it("prevents a stale worker failure from releasing a replacement lease", async () => {
    const aggregateId = `outbox-stale-failure-fencing-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.lease.stale-failure",
      aggregateId,
      payload: { test: true },
    } });

    let signalFirstEntered!: () => void;
    let signalSecondEntered!: () => void;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstEntered = new Promise<void>((resolve) => { signalFirstEntered = resolve; });
    const secondEntered = new Promise<void>((resolve) => { signalSecondEntered = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const options = {
      workerId: "worker-failure-reused-id",
      leaseSeconds: 30,
      eventTypes: ["test.lease.stale-failure"],
    };

    const firstWorker = processOneOutboxMessage(prisma, options, async () => {
      signalFirstEntered();
      await firstGate;
      throw new Error("stale handler failure");
    });
    let secondWorker: ReturnType<typeof processOneOutboxMessage> | undefined;

    try {
      await firstEntered;
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, status: "PROCESSING" },
        data: { leaseUntil: new Date(Date.now() - 1_000) },
      });

      secondWorker = processOneOutboxMessage(prisma, options, async () => {
        signalSecondEntered();
        await secondGate;
      });
      await secondEntered;

      releaseFirst();
      await expect(firstWorker).rejects.toThrow("OUTBOX_LEASE_LOST");

      const replacement = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(replacement.status).toBe("PROCESSING");
      expect(replacement.attempts).toBe(2);
      expect(replacement.lockedBy).toContain("worker-failure-reused-id:");
      expect(replacement.leaseUntil?.getTime()).toBeGreaterThan(Date.now());
      expect(replacement.lastError).toBeNull();

      releaseSecond();
      expect(await secondWorker).toBe("PUBLISHED");
    } finally {
      releaseFirst();
      releaseSecond();
      await firstWorker.catch(() => undefined);
      if (secondWorker) await secondWorker.catch(() => undefined);
    }

    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("PUBLISHED");
    expect(current.attempts).toBe(2);
    expect(current.lockedBy).toBeNull();
    expect(current.leaseUntil).toBeNull();
    expect(current.lastError).toBeNull();
  });

  it("rejects a successful handler acknowledgement after its lease expires", async () => {
    const aggregateId = `outbox-expired-success-lease-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.lease.expired-success",
      aggregateId,
      payload: { test: true },
    } });
    let entered!: () => void;
    let release!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const worker = processOneOutboxMessage(
      prisma,
      { workerId: "worker-expired-success", leaseSeconds: 5, eventTypes: ["test.lease.expired-success"] },
      async () => { entered(); await gate; },
    );
    try {
      await handlerEntered;
      await prisma.$executeRaw`
        UPDATE "OutboxEvent" SET "leaseUntil" = NOW() - INTERVAL '1 second'
        WHERE id = ${event.id} AND status = 'PROCESSING'
      `;
      release();
      await expect(worker).rejects.toThrow("OUTBOX_LEASE_LOST");
    } finally {
      release();
      await worker.catch(() => undefined);
    }
    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("PROCESSING");
    expect(current.lockedBy).toContain("worker-expired-success:");
    expect(current.leaseUntil?.getTime()).toBeLessThan(Date.now());
    expect(current.publishedAt).toBeNull();
  });

  it("does not schedule a retry after a failed handler's lease expires", async () => {
    const aggregateId = `outbox-expired-failure-lease-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.lease.expired-failure",
      aggregateId,
      payload: { test: true },
    } });
    let entered!: () => void;
    let release!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const worker = processOneOutboxMessage(
      prisma,
      { workerId: "worker-expired-failure", leaseSeconds: 5, eventTypes: ["test.lease.expired-failure"] },
      async () => { entered(); await gate; throw new Error("late handler failure"); },
    );
    try {
      await handlerEntered;
      await prisma.$executeRaw`
        UPDATE "OutboxEvent" SET "leaseUntil" = NOW() - INTERVAL '1 second'
        WHERE id = ${event.id} AND status = 'PROCESSING'
      `;
      release();
      await expect(worker).rejects.toThrow("OUTBOX_LEASE_LOST");
    } finally {
      release();
      await worker.catch(() => undefined);
    }
    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("PROCESSING");
    expect(current.lockedBy).toContain("worker-expired-failure:");
    expect(current.leaseUntil?.getTime()).toBeLessThan(Date.now());
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

    const [retryTiming] = await prisma.$queryRaw<Array<{
      isFuture: boolean;
      secondsUntilAvailable: number;
    }>>`
      SELECT
        ("availableAt" > NOW()) AS "isFuture",
        EXTRACT(EPOCH FROM ("availableAt" - NOW()))::float8 AS "secondsUntilAvailable"
      FROM "OutboxEvent"
      WHERE id = ${event.id}
    `;
    expect(retryTiming.isFuture).toBe(true);
    expect(retryTiming.secondsUntilAvailable).toBeGreaterThan(0);
    expect(retryTiming.secondsUntilAvailable).toBeLessThanOrEqual(5);
  });
  it("renews an active lease while a handler runs beyond its original deadline", async () => {
    const aggregateId = `outbox-lease-renewal-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.lease.renewal",
      aggregateId,
      payload: { test: true },
    } });

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const worker = processOneOutboxMessage(
      prisma,
      { workerId: "worker-lease-renewal", leaseSeconds: 5, eventTypes: ["test.lease.renewal"] },
      async () => {
        signalEntered();
        await new Promise((resolve) => setTimeout(resolve, 6_500));
      },
    );

    await entered;
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    const duringHandler = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(duringHandler.status).toBe("PROCESSING");
    expect(duringHandler.leaseUntil?.getTime()).toBeGreaterThan(Date.now() + 3_000);
    expect(await claimOutboxMessage(prisma, {
      workerId: "worker-lease-renewal-contender",
      eventTypes: ["test.lease.renewal"],
    })).toBeNull();

    expect(await worker).toBe("PUBLISHED");
    const completed = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(completed.status).toBe("PUBLISHED");
    expect(completed.lockedBy).toBeNull();
    expect(completed.leaseUntil).toBeNull();
  }, 15_000);

  it("does not renew an expired lease and rejects the stale handler", async () => {
    const aggregateId = `outbox-expired-heartbeat-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.lease.expired-heartbeat",
      aggregateId,
      payload: { test: true },
    } });

    let signalEntered!: () => void;
    let releaseHandler!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const worker = processOneOutboxMessage(
      prisma,
      { workerId: "worker-expired-heartbeat", leaseSeconds: 5, eventTypes: ["test.lease.expired-heartbeat"] },
      async () => {
        signalEntered();
        await handlerGate;
      },
    );

    try {
      await entered;
      await prisma.$executeRaw`
        UPDATE "OutboxEvent"
        SET "leaseUntil" = NOW() - INTERVAL '1 second'
        WHERE id = ${event.id} AND status = 'PROCESSING'
      `;
      // Allow the scheduled heartbeat to observe the expired lease and fail closed.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const expired = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(expired.leaseUntil?.getTime()).toBeLessThan(Date.now());
      await expect(claimOutboxMessage(prisma, {
        workerId: "worker-expired-heartbeat-contender",
        eventTypes: ["test.lease.expired-heartbeat"],
      })).resolves.toMatchObject({ id: event.id });
      releaseHandler();
      await expect(worker).rejects.toThrow("OUTBOX_LEASE_LOST");
    } finally {
      releaseHandler();
      await worker.catch(() => undefined);
    }
  }, 15_000);

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


  it("allows only one concurrent worker to claim and execute an eligible event", async () => {
    const aggregateId = `outbox-concurrent-claim-${process.pid}-${Date.now()}`;
    const effectScope = `outbox-concurrent-effect-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.inbox.worker.concurrent-claim",
      aggregateId,
      payload: { test: true },
    } });

    let handlerCalls = 0;
    let signalHandlerEntered!: () => void;
    let releaseHandler!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { signalHandlerEntered = resolve; });
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });

    const firstWorker = processOneOutboxMessageWithInbox(
      prisma,
      { workerId: "worker-concurrent-one", leaseSeconds: 60, eventTypes: ["test.inbox.worker.concurrent-claim"] },
      "integration-concurrent-claim",
      async (tx) => {
        handlerCalls += 1;
        signalHandlerEntered();
        await handlerGate;
        await tx.idempotencyKey.create({ data: {
          scope: effectScope,
          key: "single-effect",
          requestHash: "e".repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
        } });
      },
    );

    try {
      await handlerEntered;
      const secondResult = await processOneOutboxMessageWithInbox(
        prisma,
        { workerId: "worker-concurrent-two", leaseSeconds: 60, eventTypes: ["test.inbox.worker.concurrent-claim"] },
        "integration-concurrent-claim",
        async () => { handlerCalls += 1; },
      );
      expect(secondResult).toBe("IDLE");
    } finally {
      releaseHandler();
    }

    expect(await firstWorker).toBe("PUBLISHED");
    expect(handlerCalls).toBe(1);
    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("PUBLISHED");
    expect(current.attempts).toBe(1);
    expect(current.lockedBy).toBeNull();
    expect(current.leaseUntil).toBeNull();
    expect(await prisma.outboxConsumerReceipt.count({
      where: { eventId: event.id, consumerName: "integration-concurrent-claim" },
    })).toBe(1);
    expect(await prisma.idempotencyKey.count({ where: { scope: effectScope } })).toBe(1);
    await prisma.idempotencyKey.deleteMany({ where: { scope: effectScope } });
  });


  it("recovers a committed inbox receipt after worker crash and expired lease", async () => {
    const aggregateId = `outbox-inbox-crash-recovery-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.inbox.worker.crash-recovery",
      aggregateId,
      payload: { test: true },
      status: "PROCESSING",
      attempts: 1,
      lockedBy: "worker-crashed-before-ack",
      leaseUntil: new Date(Date.now() - 60_000),
    } });
    await prisma.outboxConsumerReceipt.create({ data: {
      consumerName: "integration-crash-recovery",
      eventId: event.id,
    } });

    const result = await processOneOutboxMessageWithInbox(
      prisma,
      { workerId: "worker-after-restart", eventTypes: ["test.inbox.worker.crash-recovery"] },
      "integration-crash-recovery",
      async () => { throw new Error("COMMITTED_RECEIPT_MUST_SKIP_HANDLER"); },
    );

    expect(result).toBe("PUBLISHED");
    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("PUBLISHED");
    expect(current.attempts).toBe(2);
    expect(current.lockedBy).toBeNull();
    expect(current.leaseUntil).toBeNull();
    expect(await prisma.outboxConsumerReceipt.count({
      where: { eventId: event.id, consumerName: "integration-crash-recovery" },
    })).toBe(1);
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
    expect(current.lastError).toContain("Authorization: [REDACTED]");
    expect(current.lastError).toContain("api_key=[REDACTED]");
    expect(current.lastError).not.toContain("test-token-123");
    expect(current.lastError).not.toContain("sk-test-secret");
    expect(await prisma.outboxConsumerReceipt.count({ where: { eventId: event.id } })).toBe(0);
  });


  it("dead-letters a failed active handler before graceful shutdown returns", async () => {
    const aggregateId = `outbox-graceful-drain-failure-${process.pid}-${Date.now()}`;
    aggregateIds.push(aggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.graceful-drain.failure", aggregateId, payload: { test: true },
    } });

    const controller = new AbortController();
    let signalEntered!: () => void;
    let releaseHandler!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const runner = runOutboxWorker(
      prisma,
      {
        workerId: "worker-graceful-drain-failure",
        leaseSeconds: 30,
        maxAttempts: 1,
        eventTypes: ["test.graceful-drain.failure"],
      },
      async () => {
        signalEntered();
        await handlerGate;
        throw new Error("Authorization: Bearer graceful-drain-test-secret");
      },
      { signal: controller.signal, pollIntervalMs: 50 },
    );

    try {
      await handlerEntered;
      controller.abort();
      releaseHandler();
      await expect(runner).resolves.toEqual({ published: 0, retried: 0, deadLettered: 1 });
    } finally {
      releaseHandler();
      await runner.catch(() => undefined);
    }

    const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(current.status).toBe("DEAD_LETTER");
    expect(current.attempts).toBe(1);
    expect(current.lockedBy).toBeNull();
    expect(current.leaseUntil).toBeNull();
    expect(current.lastError).toContain("Authorization: [REDACTED]");
    expect(current.lastError).not.toContain("graceful-drain-test-secret");
  }, 15_000);

  it("schedules a failed active handler for retry before graceful shutdown returns", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const aggregateId = `outbox-graceful-retry-${suffix}`;
    const pendingAggregateId = `outbox-graceful-retry-pending-${suffix}`;
    aggregateIds.push(aggregateId, pendingAggregateId);
    const event = await prisma.outboxEvent.create({ data: {
      eventType: "test.graceful-drain.retry", aggregateId, payload: { test: true },
    } });
    const pending = await prisma.outboxEvent.create({ data: {
      eventType: "test.graceful-drain.retry", aggregateId: pendingAggregateId, payload: { test: true },
    } });

    const controller = new AbortController();
    let signalEntered!: () => void;
    let releaseHandler!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const runner = runOutboxWorker(
      prisma,
      {
        workerId: "worker-graceful-drain-retry",
        leaseSeconds: 30,
        maxAttempts: 2,
        eventTypes: ["test.graceful-drain.retry"],
      },
      async () => {
        signalEntered();
        await handlerGate;
        throw new Error("temporary upstream failure");
      },
      { signal: controller.signal, pollIntervalMs: 50 },
    );

    try {
      await handlerEntered;
      controller.abort();
      releaseHandler();
      await expect(runner).resolves.toEqual({ published: 0, retried: 1, deadLettered: 0 });
    } finally {
      releaseHandler();
      await runner.catch(() => undefined);
    }

    const retried = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(retried.status).toBe("PENDING");
    expect(retried.attempts).toBe(1);
    expect(retried.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(retried.lockedBy).toBeNull();
    expect(retried.leaseUntil).toBeNull();
    expect(retried.lastError).toContain("temporary upstream failure");

    const untouched = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: pending.id } });
    expect(untouched.status).toBe("PENDING");
    expect(untouched.attempts).toBe(0);
    expect(untouched.lockedBy).toBeNull();
    expect(untouched.leaseUntil).toBeNull();
  }, 15_000);

  it("stops claiming on shutdown and drains the active handler before returning", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const aggregateId = `outbox-graceful-drain-${suffix}`;
    const pendingAggregateId = `outbox-graceful-drain-pending-${suffix}`;
    aggregateIds.push(aggregateId, pendingAggregateId);
    const active = await prisma.outboxEvent.create({ data: {
      eventType: "test.graceful-drain", aggregateId, payload: { test: true },
    } });
    const pending = await prisma.outboxEvent.create({ data: {
      eventType: "test.graceful-drain", aggregateId: pendingAggregateId, payload: { test: true },
    } });

    const controller = new AbortController();
    let signalEntered!: () => void;
    let releaseHandler!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    let settled = false;
    const runner = runOutboxWorker(
      prisma,
      { workerId: "worker-graceful-drain", leaseSeconds: 30, eventTypes: ["test.graceful-drain"] },
      async () => { signalEntered(); await handlerGate; },
      { signal: controller.signal, pollIntervalMs: 50 },
    ).finally(() => { settled = true; });

    try {
      await handlerEntered;
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      releaseHandler();
      await expect(runner).resolves.toEqual({ published: 1, retried: 0, deadLettered: 0 });
    } finally {
      releaseHandler();
      await runner.catch(() => undefined);
    }

    const [activeRow, pendingRow] = await Promise.all([
      prisma.outboxEvent.findUniqueOrThrow({ where: { id: active.id } }),
      prisma.outboxEvent.findUniqueOrThrow({ where: { id: pending.id } }),
    ]);
    expect(activeRow.status).toBe("PUBLISHED");
    expect(activeRow.lockedBy).toBeNull();
    expect(pendingRow.status).toBe("PENDING");
    expect(pendingRow.attempts).toBe(0);
  }, 15_000);

});

if (!databaseEnabled) {
  void prisma.$disconnect();
}
