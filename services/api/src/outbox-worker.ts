import { PrismaClient } from "@prisma/client";

export type OutboxMessage = {
  id: string; eventType: string; aggregateId: string; correlationId: string | null;
  schemaVersion: number; payload: unknown; attempts: number;
};
export type OutboxHandler = (message: OutboxMessage) => Promise<void>;
export type WorkerOptions = { workerId: string; leaseSeconds?: number; maxAttempts?: number; baseRetrySeconds?: number };

export function retryDelaySeconds(attempt: number, baseSeconds = 5): number {
  if (!Number.isFinite(baseSeconds) || baseSeconds <= 0) throw new Error("INVALID_BASE_RETRY_SECONDS");
  const safeAttempt = Number.isFinite(attempt) ? Math.floor(attempt) : 1;
  const n = Math.max(1, Math.min(12, safeAttempt));
  return Math.min(3600, baseSeconds * 2 ** (n - 1));
}

function validateWorkerOptions(options: WorkerOptions): string {
  const workerId = options.workerId.trim();
  if (!workerId) throw new Error("WORKER_ID_REQUIRED");
  if (options.maxAttempts !== undefined &&
      (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)) {
    throw new Error("INVALID_MAX_ATTEMPTS");
  }
  if (options.baseRetrySeconds !== undefined &&
      (!Number.isFinite(options.baseRetrySeconds) || options.baseRetrySeconds <= 0)) {
    throw new Error("INVALID_BASE_RETRY_SECONDS");
  }
  return workerId;
}

export async function claimOutboxMessage(prisma: PrismaClient, options: WorkerOptions): Promise<OutboxMessage | null> {
  const leaseSeconds = options.leaseSeconds ?? 60;
  const workerId = validateWorkerOptions(options);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) throw new Error("INVALID_LEASE_SECONDS");
  const rows = await prisma.$queryRawUnsafe<OutboxMessage[]>(
    'WITH candidate AS (SELECT id FROM "OutboxEvent" WHERE ((status = \'PENDING\' AND "availableAt" <= NOW()) OR (status = \'PROCESSING\' AND "leaseUntil" < NOW())) ORDER BY "availableAt", "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE "OutboxEvent" event SET status = \'PROCESSING\', attempts = event.attempts + 1, "lockedBy" = $1, "leaseUntil" = NOW() + ($2 * INTERVAL \'1 second\') FROM candidate WHERE event.id = candidate.id RETURNING event.id, event."eventType", event."aggregateId", event."correlationId", event."schemaVersion", event.payload, event.attempts',
    workerId, leaseSeconds,
  );
  return rows[0] ?? null;
}

async function markPublished(prisma: PrismaClient, id: string, workerId: string): Promise<void> {
  const result = await prisma.outboxEvent.updateMany({
    where: { id, status: "PROCESSING", lockedBy: workerId },
    data: { status: "PUBLISHED", publishedAt: new Date(), leaseUntil: null, lockedBy: null, lastError: null },
  });
  if (result.count !== 1) throw new Error("OUTBOX_LEASE_LOST");
}

async function markFailed(prisma: PrismaClient, message: OutboxMessage, options: WorkerOptions, error: unknown): Promise<void> {
  const dead = message.attempts >= (options.maxAttempts ?? 8);
  const detail = error instanceof Error ? error.message : "Unknown handler error";
  const result = await prisma.outboxEvent.updateMany({
    where: { id: message.id, status: "PROCESSING", lockedBy: options.workerId.trim() },
    data: {
      status: dead ? "DEAD_LETTER" : "PENDING",
      availableAt: new Date(Date.now() + retryDelaySeconds(message.attempts, options.baseRetrySeconds) * 1000),
      leaseUntil: null, lockedBy: null, lastError: detail.slice(0, 2000),
    },
  });
  if (result.count !== 1) throw new Error("OUTBOX_LEASE_LOST");
}

/** At-least-once delivery. Handlers must be idempotent across crash/retry boundaries. */
export async function processOneOutboxMessage(
  prisma: PrismaClient, options: WorkerOptions, handler: OutboxHandler,
): Promise<"IDLE" | "PUBLISHED" | "RETRY_SCHEDULED" | "DEAD_LETTER"> {
  const workerId = validateWorkerOptions(options);
  const normalizedOptions = { ...options, workerId };
  const message = await claimOutboxMessage(prisma, normalizedOptions);
  if (!message) return "IDLE";
  try {
    await handler(message);
    await markPublished(prisma, message.id, workerId);
    return "PUBLISHED";
  } catch (error) {
    if (error instanceof Error && error.message === "OUTBOX_LEASE_LOST") throw error;
    await markFailed(prisma, message, normalizedOptions, error);
    return message.attempts >= (normalizedOptions.maxAttempts ?? 8) ? "DEAD_LETTER" : "RETRY_SCHEDULED";
  }
}
