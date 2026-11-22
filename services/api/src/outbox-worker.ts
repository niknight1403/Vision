import { PrismaClient } from "@prisma/client";

export type OutboxMessage = {
  id: string; eventType: string; aggregateId: string; correlationId: string | null;
  schemaVersion: number; payload: unknown; attempts: number;
};
export type OutboxHandler = (message: OutboxMessage) => Promise<void>;
export type OutboxReplayResult = "REPLAYED" | "NOT_DEAD_LETTER" | "REPLAY_LIMIT_REACHED";
export type WorkerOptions = { workerId: string; leaseSeconds?: number; maxAttempts?: number; baseRetrySeconds?: number; aggregateId?: string };

export function retryDelaySeconds(attempt: number, baseSeconds = 5): number {
  const n = Math.max(1, Math.min(12, Math.floor(attempt)));
  return Math.min(3600, baseSeconds * 2 ** (n - 1));
}

export function redactOutboxError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unknown handler error";
  return raw.replace(/(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").replace(/https?:\/\/[^\s]+/gi, "[URL_REDACTED]").slice(0, 500);
}

/**
 * Return leases that outlived their owner to the queue.
 *
 * The claim query already reclaims an expired lease, but nothing reported it: a
 * worker that crashed mid-handler silently delayed every message behind it and
 * no operator could see that it happened. This makes the recovery explicit,
 * bounded and observable.
 */
export async function reapExpiredLeases(
  prisma: PrismaClient,
  options: { limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("INVALID_REAP_LIMIT");
  const expired = await prisma.outboxEvent.findMany({
    where: { status: "PROCESSING", leaseUntil: { lt: new Date() } },
    orderBy: { leaseUntil: "asc" },
    take: limit,
    select: { id: true },
  });
  if (expired.length === 0) return 0;
  const result = await prisma.outboxEvent.updateMany({
    where: { id: { in: expired.map((row) => row.id) }, status: "PROCESSING", leaseUntil: { lt: new Date() } },
    data: {
      status: "PENDING",
      availableAt: new Date(),
      leaseUntil: null,
      lockedBy: null,
      lastError: "LEASE_EXPIRED",
    },
  });
  return result.count;
}

/** Counts per outbox status; safe for a metrics gauge. */
export async function outboxStatusCounts(prisma: PrismaClient): Promise<Record<string, number>> {
  const grouped = await prisma.outboxEvent.groupBy({ by: ["status"], _count: { _all: true } });
  const counts: Record<string, number> = { PENDING: 0, PROCESSING: 0, PUBLISHED: 0, DEAD_LETTER: 0 };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}

/**
 * Re-queue one dead-lettered event, at most `maxReplays` times.
 *
 * A replay is an explicit operator decision, so it only accepts an event that is
 * currently DEAD_LETTER and has never been replayed: a repeated click, a retried
 * request or a second operator cannot resurrect the same message twice.
 */
export async function replayDeadLetter(
  prisma: PrismaClient,
  eventId: string,
  options: { maxReplays?: number } = {},
): Promise<OutboxReplayResult> {
  const maxReplays = options.maxReplays ?? 1;
  if (!Number.isInteger(maxReplays) || maxReplays < 1 || maxReplays > 5) {
    throw new Error("INVALID_MAX_REPLAYS");
  }
  if (!eventId.trim()) throw new Error("EVENT_ID_REQUIRED");
  const existing = await prisma.outboxEvent.findUnique({
    where: { id: eventId },
    select: { status: true, replayCount: true },
  });
  if (!existing) throw new Error("OUTBOX_EVENT_NOT_FOUND");
  if (existing.status !== "DEAD_LETTER") return "NOT_DEAD_LETTER";
  if (existing.replayCount >= maxReplays) return "REPLAY_LIMIT_REACHED";
  const changed = await prisma.outboxEvent.updateMany({
    where: { id: eventId, status: "DEAD_LETTER", replayCount: existing.replayCount },
    data: {
      status: "PENDING",
      attempts: 0,
      availableAt: new Date(),
      leaseUntil: null,
      lockedBy: null,
      lastError: null,
      replayCount: { increment: 1 },
    },
  });
  if (changed.count !== 1) return "REPLAY_LIMIT_REACHED";
  return "REPLAYED";
}

export async function claimOutboxMessage(prisma: PrismaClient, options: WorkerOptions): Promise<OutboxMessage | null> {
  const leaseSeconds = options.leaseSeconds ?? 60;
  if (!options.workerId.trim()) throw new Error("WORKER_ID_REQUIRED");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) throw new Error("INVALID_LEASE_SECONDS");
  const rows = await prisma.$queryRawUnsafe<OutboxMessage[]>(
    'WITH candidate AS (SELECT id FROM "OutboxEvent" WHERE ((status = \'PENDING\' AND "availableAt" <= NOW()) OR (status = \'PROCESSING\' AND "leaseUntil" < NOW())) AND ($3::text IS NULL OR "aggregateId" = $3) ORDER BY "availableAt", "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE "OutboxEvent" event SET status = \'PROCESSING\', attempts = event.attempts + 1, "lockedBy" = $1, "leaseUntil" = NOW() + ($2 * INTERVAL \'1 second\') FROM candidate WHERE event.id = candidate.id RETURNING event.id, event."eventType", event."aggregateId", event."correlationId", event."schemaVersion", event.payload, event.attempts',
    options.workerId, leaseSeconds, options.aggregateId ?? null,
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

async function markFailed(prisma: PrismaClient, message: OutboxMessage, options: WorkerOptions, error: unknown): Promise<"RETRY_SCHEDULED" | "DEAD_LETTER"> {
  const dead = message.attempts >= (options.maxAttempts ?? 8);
  const detail = redactOutboxError(error);
  const changed = await prisma.outboxEvent.updateMany({
    where: { id: message.id, status: "PROCESSING", lockedBy: options.workerId },
    data: {
      status: dead ? "DEAD_LETTER" : "PENDING",
      availableAt: new Date(Date.now() + retryDelaySeconds(message.attempts, options.baseRetrySeconds) * 1000),
      leaseUntil: null, lockedBy: null, lastError: detail.slice(0, 2000),
    },
  });
  if (changed.count !== 1) throw new Error("OUTBOX_LEASE_LOST");
  return dead ? "DEAD_LETTER" : "RETRY_SCHEDULED";
}

/** At-least-once delivery. Handlers must be idempotent across crash/retry boundaries. */
export async function processOneOutboxMessage(
  prisma: PrismaClient, options: WorkerOptions, handler: OutboxHandler,
): Promise<"IDLE" | "PUBLISHED" | "RETRY_SCHEDULED" | "DEAD_LETTER"> {
  const message = await claimOutboxMessage(prisma, options);
  if (!message) return "IDLE";
  try {
    await handler(message);
    await markPublished(prisma, message.id, options.workerId);
    return "PUBLISHED";
  } catch (error) {
    return await markFailed(prisma, message, options, error);
  }
}
