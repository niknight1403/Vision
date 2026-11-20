import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  cancelAgentTask, claimAgentTask, createAgentTask, failAgentTask, hashTaskInput, PermanentTaskError, recoverExpiredAgentTasks,
} from "./agent-task-service.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!databaseEnabled);
const prisma = new PrismaClient();
let ownerId = `task-retry-test-${process.pid}`;
let tenantId = `task-retry-tenant-${process.pid}`;
const taskIds: string[] = [];
const auxiliaryTenantIds: string[] = [];
let sequence = 0;

suite("agent task retries (PostgreSQL)", () => {
  beforeAll(async () => {
    await prisma.$connect();
    const user = await prisma.user.create({ data: {
      email: `task-retry-${process.pid}@example.test`, passwordHash: "integration-test-hash",
    } });
    ownerId = user.id;
    const tenant = await prisma.tenant.create({ data: { name: "Task retry test" } });
    tenantId = tenant.id;
    await prisma.tenantMembership.create({ data: { tenantId, userId: ownerId, role: "OWNER" } });
  });

  afterAll(async () => {
    if (taskIds.length > 0) {
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: taskIds } } });
      await prisma.agentTask.deleteMany({ where: { id: { in: taskIds } } });
    }
    await prisma.tenant.deleteMany({ where: { id: { in: auxiliaryTenantIds } } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.user.delete({ where: { id: ownerId } });
    await prisma.$disconnect();
  });

  async function createTask(maxAttempts = 3) {
    sequence += 1;
    const task = await createAgentTask(prisma, {
      ownerId,
      tenantId,
      taskType: "test",
      input: { sequence },
      idempotencyKey: `${ownerId}-${sequence}`,
      maxAttempts,
    });
    taskIds.push(task.id);
    return task;
  }

  it("requeues a retryable failure with backoff and refuses an early claim", async () => {
    const task = await createTask(3);
    const claimed = await claimAgentTask(prisma, task.id, "worker-retry");
    const retried = await failAgentTask(prisma, task.id, "worker-retry", new Error("temporary"));

    expect(retried.status).toBe("QUEUED");
    expect(retried.attempt).toBe(1);
    expect(retried.finishedAt).toBeNull();
    expect(retried.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(claimed.attempt).toBe(1);
    await expect(claimAgentTask(prisma, task.id, "worker-too-early")).rejects.toThrow("TASK_NOT_CLAIMABLE");

    await prisma.agentTask.update({ where: { id: task.id }, data: { availableAt: new Date(Date.now() - 1_000) } });
    const secondClaim = await claimAgentTask(prisma, task.id, "worker-retry-2");
    expect(secondClaim.attempt).toBe(2);
  });

  it("requires the matching tenant when cancelling an owned task", async () => {
    const task = await createTask();
    const otherTenant = await prisma.tenant.create({ data: { name: "Other cancellation workspace" } });
    auxiliaryTenantIds.push(otherTenant.id);

    await expect(cancelAgentTask(prisma, task.id, ownerId, otherTenant.id))
      .rejects.toThrow("TASK_NOT_CANCELLABLE");
    const unchanged = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(unchanged.status).toBe("QUEUED");

    const cancelled = await cancelAgentTask(prisma, task.id, ownerId, tenantId);
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("marks a retryable error terminal at maxAttempts", async () => {
    const task = await createTask(1);
    await claimAgentTask(prisma, task.id, "worker-final");
    const failed = await failAgentTask(prisma, task.id, "worker-final", new Error("last attempt"));
    expect(failed.status).toBe("FAILED");
    expect(failed.finishedAt).not.toBeNull();
    await expect(claimAgentTask(prisma, task.id, "worker-after-limit")).rejects.toThrow("TASK_ATTEMPTS_EXHAUSTED");
  });

  it("fails permanent errors immediately despite remaining attempts", async () => {
    const task = await createTask(5);
    await claimAgentTask(prisma, task.id, "worker-permanent");
    const failed = await failAgentTask(prisma, task.id, "worker-permanent", new PermanentTaskError("invalid input"));
    expect(failed.status).toBe("FAILED");
    expect(failed.attempt).toBe(1);
    expect(failed.lastError).toBe("invalid input");
  });

  it("deduplicates concurrent canonical payloads and rejects conflicting requests", async () => {
    const idempotencyKey = `${ownerId}-canonical-race`;
    const inputOne = { product: { sku: "demo-1", region: "DE" }, flags: ["paper", "draft"] };
    const inputTwo = { flags: ["paper", "draft"], product: { region: "DE", sku: "demo-1" } };
    const [first, second] = await Promise.all([
      createAgentTask(prisma, { ownerId, tenantId, taskType: "catalog.preview", input: inputOne, idempotencyKey }),
      createAgentTask(prisma, { ownerId, tenantId, taskType: "catalog.preview", input: inputTwo, idempotencyKey }),
    ]);
    taskIds.push(first.id);
    expect(second.id).toBe(first.id);
    expect(first.inputHash).toBe(hashTaskInput(inputOne));
    expect(first.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: first.id } })).toBe(1);

    await expect(createAgentTask(prisma, {
      ownerId, tenantId, taskType: "catalog.preview", input: { product: { sku: "different" } }, idempotencyKey,
    })).rejects.toThrow("TASK_IDEMPOTENCY_CONFLICT");

    const raceKey = `${ownerId}-different-payload-race`;
    const outcomes = await Promise.allSettled([
      createAgentTask(prisma, { ownerId, tenantId, taskType: "catalog.preview", input: { choice: "left" }, idempotencyKey: raceKey }),
      createAgentTask(prisma, { ownerId, tenantId, taskType: "catalog.preview", input: { choice: "right" }, idempotencyKey: raceKey }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason.message).toBe("TASK_IDEMPOTENCY_CONFLICT");
    const raceWinner = await prisma.agentTask.findUniqueOrThrow({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: raceKey } } });
    taskIds.push(raceWinner.id);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: raceWinner.id } })).toBe(1);
  });

  it("recovers an expired lease once, backs off, and terminalizes the exhausted attempt", async () => {
    const task = await createTask(2);
    await claimAgentTask(prisma, task.id, "worker-crashed-1");
    const firstRecoveryTime = new Date(Date.now() + 10_000);
    await prisma.agentTask.update({
      where: { id: task.id },
      data: { leaseUntil: new Date(firstRecoveryTime.getTime() - 1_000) },
    });

    const recoveryCounts = await Promise.all([
      recoverExpiredAgentTasks(prisma, firstRecoveryTime),
      recoverExpiredAgentTasks(prisma, firstRecoveryTime),
    ]);
    expect(recoveryCounts.reduce((sum, count) => sum + count, 0)).toBe(1);
    const requeued = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(requeued.status).toBe("QUEUED");
    expect(requeued.attempt).toBe(1);
    expect(requeued.lockedBy).toBeNull();
    expect(requeued.lastError).toBe("WORKER_LEASE_EXPIRED");
    expect(requeued.availableAt.getTime()).toBe(firstRecoveryTime.getTime() + 5_000);

    await prisma.agentTask.update({ where: { id: task.id }, data: { availableAt: new Date(Date.now() - 1_000) } });
    await claimAgentTask(prisma, task.id, "worker-crashed-2");
    const secondRecoveryTime = new Date(Date.now() + 10_000);
    await prisma.agentTask.update({
      where: { id: task.id },
      data: { leaseUntil: new Date(secondRecoveryTime.getTime() - 1_000) },
    });
    expect(await recoverExpiredAgentTasks(prisma, secondRecoveryTime)).toBe(1);
    const terminal = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(terminal.status).toBe("FAILED");
    expect(terminal.attempt).toBe(2);
    expect(terminal.finishedAt).toEqual(secondRecoveryTime);
    expect(terminal.lockedBy).toBeNull();
    expect(terminal.leaseUntil).toBeNull();
  });
});

if (!databaseEnabled) void prisma.$disconnect();
