import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  claimAgentTask, completeAgentTask, failAgentTask, PermanentTaskError, recoverExpiredAgentTasks,
  saveTaskCheckpoint,
} from "./agent-task-service.js";

type JsonObject = Prisma.InputJsonObject;
type TaskRecord = {
  id: string; taskType: string; input: Prisma.JsonValue; checkpoint: Prisma.JsonValue | null;
  ownerId: string; correlationId: string | null; attempt: number; maxAttempts: number;
};
export type TaskHandlerContext = {
  signal: AbortSignal;
  checkpoint(value: JsonObject): Promise<void>;
};
export type TaskHandler = (task: TaskRecord, context: TaskHandlerContext) => Promise<JsonObject>;
export type OrchestratorOptions = {
  workerId: string;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
};

export function waitForPoll(signal: AbortSignal, delayMs: number): Promise<void> {
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("INVALID_POLL_DELAY");
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => finish();
    timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish();
  });
}

export async function heartbeatTaskLease(
  prisma: PrismaClient, taskId: string, workerId: string, leaseSeconds = 90,
): Promise<Date> {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) throw new Error("INVALID_LEASE_SECONDS");
  const leaseUntil = new Date(Date.now() + leaseSeconds * 1000);
  const updated = await prisma.agentTask.updateMany({
    where: { id: taskId, status: "RUNNING", lockedBy: workerId, leaseUntil: { gt: new Date() } },
    data: { leaseUntil },
  });
  if (updated.count !== 1) throw new Error("TASK_LEASE_LOST");
  return leaseUntil;
}

export async function listClaimableTaskIds(prisma: PrismaClient, limit = 20): Promise<string[]> {
  const tasks = await prisma.agentTask.findMany({
    where: {
      attempt: { lt: 20 },
      OR: [
        { status: "QUEUED", availableAt: { lte: new Date() } },
        { status: "CHECKPOINTED" },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(100, limit * 2)),
    select: { id: true, attempt: true, maxAttempts: true },
  });
  return tasks.filter((task) => task.attempt < task.maxAttempts).slice(0, limit).map((task) => task.id);
}

async function executeTask(
  prisma: PrismaClient, taskId: string, baseWorkerId: string, options: OrchestratorOptions,
  handlers: Record<string, TaskHandler>,
): Promise<boolean> {
  // Unique per-claim fencing token prevents a stale process reusing a worker name.
  const workerId = baseWorkerId + ":" + randomUUID();
  let task;
  try {
    task = await claimAgentTask(prisma, taskId, workerId, options.leaseSeconds ?? 90);
  } catch {
    return false; // another worker won the claim or task became ineligible
  }
  const handler = handlers[task.taskType];
  if (!handler) {
    await failAgentTask(prisma, taskId, workerId, new PermanentTaskError("NO_HANDLER_REGISTERED"));
    return true;
  }

  const controller = new AbortController();
  let leaseLost = false;
  const heartbeatMs = options.heartbeatIntervalMs ?? 25_000;
  const timer = setInterval(() => {
    void heartbeatTaskLease(prisma, taskId, workerId, options.leaseSeconds ?? 90)
      .catch(() => { leaseLost = true; controller.abort(new Error("TASK_LEASE_LOST")); });
  }, heartbeatMs);

  try {
    const result = await handler(task as TaskRecord, {
      signal: controller.signal,
      checkpoint: async (value) => {
        if (leaseLost) throw new Error("TASK_LEASE_LOST");
        await saveTaskCheckpoint(prisma, taskId, workerId, value);
      },
    });
    if (leaseLost || controller.signal.aborted) throw new Error("TASK_LEASE_LOST");
    await completeAgentTask(prisma, taskId, workerId, result);
  } catch (error) {
    if (!leaseLost) {
      try { await failAgentTask(prisma, taskId, workerId, error); } catch { /* Lease may have been reclaimed. */ }
    }
  } finally {
    clearInterval(timer);
  }
  return true;
}

/** Runs bounded concurrent polling loops. Stop with AbortSignal; handlers receive the same signal. */
export async function runAgentOrchestrator(
  prisma: PrismaClient, options: OrchestratorOptions, handlers: Record<string, TaskHandler>, signal: AbortSignal,
): Promise<void> {
  const concurrency = options.concurrency ?? 2;
  const pollMs = options.pollIntervalMs ?? 1000;
  if (!options.workerId.trim()) throw new Error("WORKER_ID_REQUIRED");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("INVALID_CONCURRENCY");
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error("INVALID_POLL_INTERVAL");

  const loops = Array.from({ length: concurrency }, async (_, index) => {
    const workerName = options.workerId + "-" + index;
    while (!signal.aborted) {
      await recoverExpiredAgentTasks(prisma);
      if (signal.aborted) break;
      const ids = await listClaimableTaskIds(prisma, concurrency * 2);
      let didWork = false;
      for (const id of ids) {
        if (signal.aborted) break;
        if (await executeTask(prisma, id, workerName, options, handlers)) {
          didWork = true;
          break;
        }
      }
      if (!didWork) {
        await waitForPoll(signal, pollMs);
      }
    }
  });
  await Promise.all(loops);
}
