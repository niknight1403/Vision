import { Prisma, PrismaClient } from "@prisma/client";
import { processOutboxEventInTransaction, type TransactionalOutboxConsumer } from "./outbox-inbox.js";

export type OutboxMessage = {
  id: string; eventType: string; aggregateId: string; correlationId: string | null;
  schemaVersion: number; payload: unknown; attempts: number;
};
export type OutboxHandler = (message: OutboxMessage) => Promise<void>;
export type WorkerOptions = { workerId: string; leaseSeconds?: number; maxAttempts?: number; baseRetrySeconds?: number; eventTypes?: string[] };

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
  if (options.eventTypes !== undefined &&
      (options.eventTypes.length === 0 || options.eventTypes.some((type) => !type.trim()))) {
    throw new Error("INVALID_EVENT_TYPES");
  }
  return workerId;
}

export async function claimOutboxMessage(prisma: PrismaClient, options: WorkerOptions): Promise<OutboxMessage | null> {
  const leaseSeconds = options.leaseSeconds ?? 60;
  const workerId = validateWorkerOptions(options);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) throw new Error("INVALID_LEASE_SECONDS");
  const eventTypeFilter = options.eventTypes?.length
    ? Prisma.sql`AND "eventType" IN (${Prisma.join(options.eventTypes)})`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<OutboxMessage[]>(Prisma.sql`
    WITH candidate AS (
      SELECT id FROM "OutboxEvent"
      WHERE (
        (status = 'PENDING' AND "availableAt" <= NOW())
        OR (status = 'PROCESSING' AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW()))
      )
      ${eventTypeFilter}
      ORDER BY "availableAt", "createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "OutboxEvent" event
    SET status = 'PROCESSING',
        attempts = event.attempts + 1,
        "lockedBy" = ${workerId},
        "leaseUntil" = NOW() + (${leaseSeconds} * INTERVAL '1 second')
    FROM candidate
    WHERE event.id = candidate.id
    RETURNING event.id, event."eventType", event."aggregateId", event."correlationId",
              event."schemaVersion", event.payload, event.attempts
  `);
  return rows[0] ?? null;
}

async function markPublished(prisma: PrismaClient, id: string, workerId: string): Promise<void> {
  const result = await prisma.outboxEvent.updateMany({
    where: { id, status: "PROCESSING", lockedBy: workerId, leaseUntil: { gt: new Date() } },
    data: { status: "PUBLISHED", publishedAt: new Date(), leaseUntil: null, lockedBy: null, lastError: null },
  });
  if (result.count !== 1) throw new Error("OUTBOX_LEASE_LOST");
}

export function sanitizeOutboxError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unknown handler error";
  return raw
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\b(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .slice(0, 2000);
}

async function markFailed(prisma: PrismaClient, message: OutboxMessage, options: WorkerOptions, error: unknown): Promise<void> {
  const dead = message.attempts >= (options.maxAttempts ?? 8);
  const detail = sanitizeOutboxError(error);
  const result = await prisma.outboxEvent.updateMany({
    where: { id: message.id, status: "PROCESSING", lockedBy: options.workerId.trim(), leaseUntil: { gt: new Date() } },
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


/**
 * Runs a database-only consumer with a durable inbox receipt. Consumer writes
 * and receipt commit atomically; the outbox acknowledgement follows. If the
 * process crashes between those commits, redelivery is a safe DUPLICATE.
 * Do not use this helper for remote side effects; those need provider-level
 * idempotency and reconciliation.
 */
export async function processOneOutboxMessageWithInbox(
  prisma: PrismaClient,
  options: WorkerOptions,
  consumerName: string,
  handler: TransactionalOutboxConsumer,
): Promise<"IDLE" | "PUBLISHED" | "RETRY_SCHEDULED" | "DEAD_LETTER"> {
  const workerId = validateWorkerOptions(options);
  const normalizedOptions = { ...options, workerId };
  const message = await claimOutboxMessage(prisma, normalizedOptions);
  if (!message) return "IDLE";

  try {
    await prisma.$transaction((tx) =>
      processOutboxEventInTransaction(tx, consumerName, message, handler),
    );
    await markPublished(prisma, message.id, workerId);
    return "PUBLISHED";
  } catch (error) {
    if (error instanceof Error && error.message === "OUTBOX_LEASE_LOST") throw error;
    await markFailed(prisma, message, normalizedOptions, error);
    return message.attempts >= (normalizedOptions.maxAttempts ?? 8)
      ? "DEAD_LETTER"
      : "RETRY_SCHEDULED";
  }
}
