import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;
type JsonObject = Prisma.InputJsonObject;

export class PermanentTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentTaskError";
  }
}

export function taskRetryDelaySeconds(attempt: number, baseSeconds = 5): number {
  if (!Number.isInteger(baseSeconds) || baseSeconds < 1 || baseSeconds > 300) {
    throw new Error("INVALID_RETRY_BASE_SECONDS");
  }
  const exponent = Math.max(0, Math.min(10, Math.floor(attempt) - 1));
  return Math.min(3_600, baseSeconds * 2 ** exponent);
}

export type CreateTaskInput = {
  ownerId: string;
  taskType: string;
  input: JsonObject;
  idempotencyKey: string;
  correlationId?: string;
  maxAttempts?: number;
};

function canonicalizeJsonValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new Error("TASK_INPUT_NOT_JSON");
  if (ancestors.has(value)) throw new Error("TASK_INPUT_NOT_JSON");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalizeJsonValue(item, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("TASK_INPUT_NOT_JSON");
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object).sort().map((key) => {
      const item = object[key];
      if (item === undefined) throw new Error("TASK_INPUT_NOT_JSON");
      return [key, canonicalizeJsonValue(item, ancestors)] as const;
    });
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeTaskInput(value: unknown): JsonObject {
  const canonical = canonicalizeJsonValue(value);
  if (canonical === null || Array.isArray(canonical) || typeof canonical !== "object") {
    throw new Error("TASK_INPUT_MUST_BE_OBJECT");
  }
  return canonical as JsonObject;
}

export function hashTaskInput(value: unknown): string {
  const canonical = canonicalizeTaskInput(value);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function matchIdempotentTask(
  existing: Prisma.AgentTaskGetPayload<object>, input: CreateTaskInput, inputHash: string, maxAttempts: number,
) {
  const existingHash = existing.inputHash ?? hashTaskInput(existing.input);
  if (existing.ownerId !== input.ownerId || existing.taskType !== input.taskType ||
      existingHash !== inputHash || existing.maxAttempts !== maxAttempts) {
    throw new Error("TASK_IDEMPOTENCY_CONFLICT");
  }
  return existing;
}

async function emit(db: Db, eventType: string, taskId: string, correlationId: string | undefined, payload: JsonObject) {
  await db.outboxEvent.create({
    data: { eventType, aggregateId: taskId, correlationId, payload, schemaVersion: 1 },
  });
}

export async function createAgentTask(prisma: PrismaClient, input: CreateTaskInput) {
  if (!input.ownerId.trim() || !input.taskType.trim() || !input.idempotencyKey.trim()) {
    throw new Error("TASK_REQUIRED_FIELDS_MISSING");
  }
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new Error("INVALID_MAX_ATTEMPTS");
  }
  const idempotencyKey = input.idempotencyKey.trim();
  const canonicalInput = canonicalizeTaskInput(input.input);
  const inputHash = createHash("sha256").update(JSON.stringify(canonicalInput)).digest("hex");

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.agentTask.findUnique({ where: { idempotencyKey } });
      if (existing) return matchIdempotentTask(existing, input, inputHash, maxAttempts);
      const task = await tx.agentTask.create({
        data: {
          ownerId: input.ownerId, taskType: input.taskType, input: canonicalInput, inputHash,
          idempotencyKey, correlationId: input.correlationId, maxAttempts,
        },
      });
      await emit(tx, "agent.task.created", task.id, input.correlationId, {
        taskId: task.id, taskType: task.taskType, ownerId: task.ownerId,
      });
      return task;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const concurrent = await prisma.agentTask.findUnique({ where: { idempotencyKey } });
      if (concurrent) return matchIdempotentTask(concurrent, input, inputHash, maxAttempts);
    }
    throw error;
  }
}

/**
 * Atomically claim the oldest eligible task of one type. PostgreSQL holds the
 * candidate row lock only for this transaction; concurrent workers skip it and
 * can claim another task. The started event is committed with the lease update.
 */
export async function claimNextAgentTask(
  prisma: PrismaClient,
  taskType: string,
  workerId: string,
  leaseSeconds = 90,
) {
  if (!taskType.trim()) throw new Error("TASK_TYPE_REQUIRED");
  if (!workerId.trim()) throw new Error("WORKER_ID_REQUIRED");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) {
    throw new Error("INVALID_LEASE_SECONDS");
  }

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<Prisma.AgentTaskGetPayload<object>[]>(Prisma.sql`
      WITH candidate AS (
        SELECT id
        FROM "AgentTask"
        WHERE "taskType" = ${taskType}
          AND status = 'QUEUED'
          AND "availableAt" <= NOW()
          AND attempt < "maxAttempts"
        ORDER BY "availableAt" ASC, "createdAt" ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "AgentTask" AS task
      SET status = 'RUNNING',
          attempt = task.attempt + 1,
          "lockedBy" = ${workerId},
          "leaseUntil" = NOW() + (${leaseSeconds} * INTERVAL '1 second'),
          "startedAt" = COALESCE(task."startedAt", NOW()),
          "lastError" = NULL,
          "updatedAt" = NOW()
      FROM candidate
      WHERE task.id = candidate.id
      RETURNING task.*
    `);
    const task = claimed[0];
    if (!task) return null;

    await emit(tx, "agent.task.started", task.id, task.correlationId ?? undefined, {
      taskId: task.id,
      workerId,
      attempt: task.attempt,
    });
    return task;
  });
}

/** Compare-and-set claim. A crashed worker's expired lease can be reclaimed. */
export async function claimAgentTask(prisma: PrismaClient, taskId: string, workerId: string, leaseSeconds = 90) {
  if (!workerId.trim()) throw new Error("WORKER_ID_REQUIRED");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) {
    throw new Error("INVALID_LEASE_SECONDS");
  }
  return prisma.$transaction(async (tx) => {
    const task = await tx.agentTask.findUnique({ where: { id: taskId } });
    if (!task) throw new Error("TASK_NOT_FOUND");
    if (task.attempt >= task.maxAttempts) throw new Error("TASK_ATTEMPTS_EXHAUSTED");
    const now = new Date();
    const eligible = (task.status === "QUEUED" && task.availableAt <= now) || task.status === "CHECKPOINTED" ||
      (task.status === "RUNNING" && task.leaseUntil !== null && task.leaseUntil < now);
    if (!eligible) throw new Error("TASK_NOT_CLAIMABLE");
    const claimed = await tx.agentTask.updateMany({
      where: {
        id: taskId,
        status: task.status,
        attempt: task.attempt,
        ...(task.status === "QUEUED" ? { availableAt: { lte: now } } : {}),
      },
      data: {
        status: "RUNNING", attempt: { increment: 1 }, lockedBy: workerId,
        leaseUntil: new Date(Date.now() + leaseSeconds * 1000),
        startedAt: task.startedAt ?? new Date(), lastError: null,
      },
    });
    if (claimed.count !== 1) throw new Error("TASK_CLAIM_CONFLICT");
    const updated = await tx.agentTask.findUniqueOrThrow({ where: { id: taskId } });
    await emit(tx, "agent.task.started", taskId, task.correlationId ?? undefined, {
      taskId, workerId, attempt: updated.attempt,
    });
    return updated;
  });
}

export async function saveTaskCheckpoint(
  prisma: PrismaClient, taskId: string, workerId: string, checkpoint: JsonObject,
) {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.agentTask.updateMany({
      where: { id: taskId, status: "RUNNING", lockedBy: workerId, leaseUntil: { gt: new Date() } },
      data: { checkpoint },
    });
    if (changed.count !== 1) throw new Error("TASK_LEASE_LOST");
    const task = await tx.agentTask.findUniqueOrThrow({ where: { id: taskId } });
    await emit(tx, "agent.task.checkpointed", taskId, task.correlationId ?? undefined, { taskId });
    return task;
  });
}

export async function completeAgentTask(
  prisma: PrismaClient, taskId: string, workerId: string, result: JsonObject,
) {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.agentTask.updateMany({
      where: { id: taskId, status: "RUNNING", lockedBy: workerId, leaseUntil: { gt: new Date() } },
      data: { status: "SUCCEEDED", result, lockedBy: null, leaseUntil: null, finishedAt: new Date() },
    });
    if (changed.count !== 1) throw new Error("TASK_LEASE_LOST");
    const task = await tx.agentTask.findUniqueOrThrow({ where: { id: taskId } });
    await emit(tx, "agent.task.succeeded", taskId, task.correlationId ?? undefined, { taskId });
    return task;
  });
}

export async function failAgentTask(prisma: PrismaClient, taskId: string, workerId: string, error: unknown) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const current = await tx.agentTask.findUnique({ where: { id: taskId } });
    if (!current || current.status !== "RUNNING" || current.lockedBy !== workerId ||
        !current.leaseUntil || current.leaseUntil <= now) {
      throw new Error("TASK_LEASE_LOST");
    }
    const detail = (error instanceof Error ? error.message : "Unknown task error").slice(0, 2000);
    const retry = !(error instanceof PermanentTaskError) && current.attempt < current.maxAttempts;
    const availableAt = retry
      ? new Date(now.getTime() + taskRetryDelaySeconds(current.attempt) * 1000)
      : current.availableAt;
    const changed = await tx.agentTask.updateMany({
      where: { id: taskId, status: "RUNNING", lockedBy: workerId, attempt: current.attempt, leaseUntil: { gt: now } },
      data: {
        status: retry ? "QUEUED" : "FAILED",
        availableAt,
        lastError: detail,
        lockedBy: null,
        leaseUntil: null,
        finishedAt: retry ? null : now,
      },
    });
    if (changed.count !== 1) throw new Error("TASK_LEASE_LOST");
    const task = await tx.agentTask.findUniqueOrThrow({ where: { id: taskId } });
    await emit(tx, retry ? "agent.task.retry_scheduled" : "agent.task.failed", taskId, task.correlationId ?? undefined, {
      taskId, error: detail, attempt: task.attempt, availableAt: availableAt.toISOString(),
    });
    return task;
  });
}

/** Cancellation is an internal privileged operation; expose it only behind server-side RBAC. */
export async function cancelAgentTask(prisma: PrismaClient, taskId: string, ownerId: string) {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.agentTask.updateMany({
      where: { id: taskId, ownerId, status: { in: ["QUEUED", "CHECKPOINTED"] } },
      data: { status: "CANCELLED", finishedAt: new Date(), lockedBy: null, leaseUntil: null },
    });
    if (changed.count !== 1) throw new Error("TASK_NOT_CANCELLABLE");
    const task = await tx.agentTask.findUniqueOrThrow({ where: { id: taskId } });
    await emit(tx, "agent.task.cancelled", taskId, task.correlationId ?? undefined, { taskId });
    return task;
  });
}

/** Requeue expired leases with attempts remaining; atomically terminalize exhausted tasks. */
export async function recoverExpiredAgentTasks(prisma: PrismaClient, now = new Date(), limit = 100): Promise<number> {
  const expired = await prisma.agentTask.findMany({
    where: { status: "RUNNING", leaseUntil: { lt: now } },
    orderBy: { leaseUntil: "asc" },
    take: Math.max(1, Math.min(500, limit)),
    select: { id: true, attempt: true, maxAttempts: true, correlationId: true },
  });
  let recovered = 0;
  for (const task of expired) {
    const retry = task.attempt < task.maxAttempts;
    const availableAt = retry
      ? new Date(now.getTime() + taskRetryDelaySeconds(task.attempt) * 1000)
      : now;
    await prisma.$transaction(async (tx) => {
      const changed = await tx.agentTask.updateMany({
        where: { id: task.id, status: "RUNNING", attempt: task.attempt, leaseUntil: { lt: now } },
        data: {
          status: retry ? "QUEUED" : "FAILED",
          availableAt,
          lastError: "WORKER_LEASE_EXPIRED",
          lockedBy: null,
          leaseUntil: null,
          finishedAt: retry ? null : now,
        },
      });
      if (changed.count !== 1) return; // A heartbeat or another recovery won the race.
      await emit(tx, retry ? "agent.task.retry_scheduled" : "agent.task.failed", task.id,
        task.correlationId ?? undefined, {
          taskId: task.id,
          error: "WORKER_LEASE_EXPIRED",
          attempt: task.attempt,
          availableAt: availableAt.toISOString(),
        });
      recovered += 1;
    });
  }
  return recovered;
}
