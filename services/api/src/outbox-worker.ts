import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { processOutboxEventInTransaction, type TransactionalOutboxConsumer } from "./outbox-inbox.js";

export type OutboxMessage = {
  id: string; eventType: string; aggregateId: string; correlationId: string | null;
  schemaVersion: number; payload: unknown; attempts: number;
};
type ClaimedOutboxMessage = OutboxMessage & { claimToken: string };
export type OutboxHandler = (message: OutboxMessage) => Promise<void>;
export type OutboxReplayResult = "REPLAYED" | "NOT_DEAD_LETTER" | "REPLAY_LIMIT_REACHED";
export type WorkerOptions = { workerId: string; leaseSeconds?: number; maxAttempts?: number; baseRetrySeconds?: number; eventTypes?: string[]; aggregateId?: string };

export function retryDelaySeconds(attempt: number, baseSeconds = 5): number {
  if (!Number.isFinite(baseSeconds) || baseSeconds <= 0) throw new Error("INVALID_BASE_RETRY_SECONDS");
  const safeAttempt = Number.isFinite(attempt) ? Math.floor(attempt) : 1;
  const n = Math.max(1, Math.min(12, safeAttempt));
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

export async function claimOutboxMessage(prisma: PrismaClient, options: WorkerOptions): Promise<ClaimedOutboxMessage | null> {
  const leaseSeconds = options.leaseSeconds ?? 60;
  const workerId = validateWorkerOptions(options);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) throw new Error("INVALID_LEASE_SECONDS");
  const claimToken = `${workerId}:${randomUUID()}`;
  const eventTypeFilter = options.eventTypes?.length
    ? Prisma.sql`AND "eventType" IN (${Prisma.join(options.eventTypes)})`
    : Prisma.empty;
  const aggregateFilter = options.aggregateId
    ? Prisma.sql`AND "aggregateId" = ${options.aggregateId}`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<ClaimedOutboxMessage[]>(Prisma.sql`
    WITH candidate AS (
      SELECT id FROM "OutboxEvent"
      WHERE (
        (status = 'PENDING' AND "availableAt" <= NOW())
        OR (status = 'PROCESSING' AND "leaseUntil" < NOW())
      )
      ${eventTypeFilter}
      ${aggregateFilter}
      ORDER BY "availableAt", "createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "OutboxEvent" event
    SET status = 'PROCESSING',
        attempts = event.attempts + 1,
        "lockedBy" = ${claimToken},
        "leaseUntil" = NOW() + (${leaseSeconds} * INTERVAL '1 second')
    FROM candidate
    WHERE event.id = candidate.id
    RETURNING event.id, event."eventType", event."aggregateId", event."correlationId",
              event."schemaVersion", event.payload, event.attempts, event."lockedBy" AS "claimToken"
  `);
  return rows[0] ?? null;
}

async function withLeaseHeartbeat<T>(
  prisma: PrismaClient,
  message: ClaimedOutboxMessage,
  leaseSeconds: number,
  handler: () => Promise<T>,
): Promise<T> {
  const intervalMs = Math.max(250, Math.floor((leaseSeconds * 1000) / 3));
  let stopped = false;
  let renewalError: Error | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewalInFlight: Promise<void> | undefined;

  const scheduleRenewal = () => {
    if (stopped || renewalError) return;
    timer = setTimeout(() => {
      renewalInFlight = (async () => {
        const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "OutboxEvent"
          SET "leaseUntil" = NOW() + (${leaseSeconds} * INTERVAL '1 second')
          WHERE id = ${message.id} AND status = 'PROCESSING'
            AND "lockedBy" = ${message.claimToken} AND "leaseUntil" > NOW()
          RETURNING id
        `);
        if (rows.length !== 1) throw new Error("OUTBOX_LEASE_LOST");
      })().catch((error: unknown) => {
        renewalError = error instanceof Error ? error : new Error("OUTBOX_LEASE_LOST");
      }).finally(() => {
        renewalInFlight = undefined;
        scheduleRenewal();
      });
    }, intervalMs);
    // The heartbeat must not keep an otherwise-idle worker process alive.
    timer.unref?.();
  };

  scheduleRenewal();
  try {
    const result = await handler();
    stopped = true;
    if (timer) clearTimeout(timer);
    if (renewalInFlight) await renewalInFlight;
    if (renewalError) throw renewalError;
    return result;
  } catch (error) {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (renewalInFlight) await renewalInFlight;
    if (renewalError) throw renewalError;
    throw error;
  }
}

async function markPublished(prisma: PrismaClient, id: string, claimToken: string): Promise<void> {
  // Evaluate lease ownership against PostgreSQL's clock, matching claimOutboxMessage.
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "OutboxEvent"
    SET status = 'PUBLISHED', "publishedAt" = NOW(), "leaseUntil" = NULL,
        "lockedBy" = NULL, "lastError" = NULL
    WHERE id = ${id} AND status = 'PROCESSING'
      AND "lockedBy" = ${claimToken} AND "leaseUntil" > NOW()
    RETURNING id
  `);
  if (rows.length !== 1) throw new Error("OUTBOX_LEASE_LOST");
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

async function markFailed(prisma: PrismaClient, message: ClaimedOutboxMessage, options: WorkerOptions, error: unknown): Promise<void> {
  const dead = message.attempts >= (options.maxAttempts ?? 8);
  const detail = sanitizeOutboxError(error);
  const retrySeconds = retryDelaySeconds(message.attempts, options.baseRetrySeconds);
  // Use PostgreSQL time for both lease ownership and retry eligibility.
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "OutboxEvent"
    SET status = ${dead ? "DEAD_LETTER" : "PENDING"}::"OutboxStatus",
        "availableAt" = NOW() + (${retrySeconds} * INTERVAL '1 second'), "leaseUntil" = NULL,
        "lockedBy" = NULL, "lastError" = ${detail.slice(0, 2000)}
    WHERE id = ${message.id} AND status = 'PROCESSING'
      AND "lockedBy" = ${message.claimToken} AND "leaseUntil" > NOW()
    RETURNING id
  `);
  if (rows.length !== 1) throw new Error("OUTBOX_LEASE_LOST");
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
    const { claimToken, ...publicMessage } = message;
    await withLeaseHeartbeat(
      prisma,
      message,
      normalizedOptions.leaseSeconds ?? 60,
      () => handler(publicMessage),
    );
    await markPublished(prisma, message.id, claimToken);
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
    const { claimToken, ...publicMessage } = message;
    await withLeaseHeartbeat(
      prisma,
      message,
      normalizedOptions.leaseSeconds ?? 60,
      () => prisma.$transaction((tx) =>
        processOutboxEventInTransaction(tx, consumerName, publicMessage, handler),
      ),
    );
    await markPublished(prisma, message.id, claimToken);
    return "PUBLISHED";
  } catch (error) {
    if (error instanceof Error && error.message === "OUTBOX_LEASE_LOST") throw error;
    await markFailed(prisma, message, normalizedOptions, error);
    return message.attempts >= (normalizedOptions.maxAttempts ?? 8)
      ? "DEAD_LETTER"
      : "RETRY_SCHEDULED";
  }
}


// A drain runner owns polling, not handler cancellation. Aborting the signal stops
// future claims; an already-claimed message is awaited through its normal ack/retry path.
export type OutboxRunnerOptions = {
  signal: AbortSignal;
  pollIntervalMs?: number;
};

export async function runOutboxWorker(
  prisma: PrismaClient,
  options: WorkerOptions,
  handler: OutboxHandler,
  runner: OutboxRunnerOptions,
): Promise<{ published: number; retried: number; deadLettered: number }> {
  const pollIntervalMs = runner.pollIntervalMs ?? 1_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 30_000) {
    throw new Error("INVALID_POLL_INTERVAL_MS");
  }

  const totals = { published: 0, retried: 0, deadLettered: 0 };
  while (!runner.signal.aborted) {
    const result = await processOneOutboxMessage(prisma, options, handler);
    if (result === "PUBLISHED") totals.published += 1;
    else if (result === "RETRY_SCHEDULED") totals.retried += 1;
    else if (result === "DEAD_LETTER") totals.deadLettered += 1;
    else if (!runner.signal.aborted) {
      await new Promise<void>((resolve) => {
        if (runner.signal.aborted) return resolve();
        const timer = setTimeout(done, pollIntervalMs);
        function done() {
          runner.signal.removeEventListener("abort", onAbort);
          resolve();
        }
        function onAbort() {
          clearTimeout(timer);
          done();
        }
        runner.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  return totals;
}
