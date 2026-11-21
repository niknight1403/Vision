import { PrismaClient } from "@prisma/client";

export type ReconciliationEvent = {
  id: string;
  eventType: string;
  status: "PENDING" | "PROCESSING" | "PUBLISHED" | "DEAD_LETTER";
  attempts: number;
  availableAt: Date;
  leaseUntil: Date | null;
  lockedBy: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  consumerReceipts: Array<{ consumerName: string; processedAt: Date }>;
};

export type OutboxFinding = {
  code:
    | "EXPIRED_LEASE"
    | "PROCESSING_LEASE_INCOMPLETE"
    | "UNEXPECTED_LOCK"
    | "PUBLISHED_TIMESTAMP_MISSING"
    | "REQUIRED_RECEIPT_MISSING"
    | "DEAD_LETTER"
    | "PENDING_OVERDUE";
  severity: "WARNING" | "CRITICAL";
  eventId: string;
  eventType: string;
  consumerName?: string;
};

export type OutboxReconciliationReport = {
  scanned: number;
  counts: Record<ReconciliationEvent["status"], number>;
  findings: OutboxFinding[];
  generatedAt: string;
};

/**
 * Read-only consistency check. expectedConsumers is an explicit operational
 * contract: only listed consumers are required to receipt a given event type.
 */
export function reconcileOutboxEvents(
  events: ReconciliationEvent[],
  expectedConsumers: Record<string, string[]>,
  options: { now?: Date; pendingWarningSeconds?: number } = {},
): OutboxReconciliationReport {
  const now = options.now ?? new Date();
  const pendingWarningSeconds = options.pendingWarningSeconds ?? 300;
  if (!Number.isFinite(pendingWarningSeconds) || pendingWarningSeconds < 0) {
    throw new Error("INVALID_PENDING_WARNING_SECONDS");
  }

  for (const [eventType, consumerNames] of Object.entries(expectedConsumers)) {
    if (!eventType.trim() || !Array.isArray(consumerNames) ||
        consumerNames.some((name) => typeof name !== "string" || !name.trim())) {
      throw new Error("INVALID_EXPECTED_CONSUMERS");
    }
    // This outbox currently has one terminal PUBLISHED state per event, not
    // per-consumer delivery rows. Multiple independent consumers would make
    // the report promise fan-out that the dispatcher cannot currently deliver.
    if (consumerNames.length > 1) {
      throw new Error("OUTBOX_MULTI_CONSUMER_FANOUT_UNSUPPORTED");
    }
  }

  const counts: OutboxReconciliationReport["counts"] = {
    PENDING: 0, PROCESSING: 0, PUBLISHED: 0, DEAD_LETTER: 0,
  };
  const findings: OutboxFinding[] = [];
  const add = (code: OutboxFinding["code"], severity: OutboxFinding["severity"], event: ReconciliationEvent, consumerName?: string) => {
    findings.push({ code, severity, eventId: event.id, eventType: event.eventType, ...(consumerName ? { consumerName } : {}) });
  };

  for (const event of events) {
    counts[event.status] += 1;
    const hasLock = event.lockedBy !== null;
    const hasLease = event.leaseUntil !== null;

    if (event.status === "PROCESSING") {
      if (!hasLock || !hasLease) add("PROCESSING_LEASE_INCOMPLETE", "CRITICAL", event);
      else if (event.leaseUntil!.getTime() < now.getTime()) add("EXPIRED_LEASE", "WARNING", event);
    } else if (hasLock || hasLease) {
      add("UNEXPECTED_LOCK", "CRITICAL", event);
    }

    if (event.status === "PUBLISHED") {
      if (!event.publishedAt) add("PUBLISHED_TIMESTAMP_MISSING", "CRITICAL", event);
      const receipts = new Set(event.consumerReceipts.map((receipt) => receipt.consumerName));
      for (const consumerName of expectedConsumers[event.eventType] ?? []) {
        if (!receipts.has(consumerName)) add("REQUIRED_RECEIPT_MISSING", "CRITICAL", event, consumerName);
      }
    }

    if (event.status === "DEAD_LETTER") add("DEAD_LETTER", "WARNING", event);
    if (event.status === "PENDING" &&
        now.getTime() - event.availableAt.getTime() > pendingWarningSeconds * 1000) {
      add("PENDING_OVERDUE", "WARNING", event);
    }
  }

  return { scanned: events.length, counts, findings, generatedAt: now.toISOString() };
}

/** Reads a bounded window and returns metadata only; event payloads are never selected. */
export async function reconcileOutbox(
  prisma: PrismaClient,
  options: {
    since?: Date;
    limit?: number;
    now?: Date;
    pendingWarningSeconds?: number;
    expectedConsumers?: Record<string, string[]>;
  } = {},
): Promise<OutboxReconciliationReport> {
  const limit = options.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    throw new Error("INVALID_RECONCILIATION_LIMIT");
  }
  const events = await prisma.outboxEvent.findMany({
    where: options.since ? { createdAt: { gte: options.since } } : undefined,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true, eventType: true, status: true, attempts: true,
      availableAt: true, leaseUntil: true, lockedBy: true,
      publishedAt: true, createdAt: true,
      consumerReceipts: { select: { consumerName: true, processedAt: true } },
    },
  });
  return reconcileOutboxEvents(events as ReconciliationEvent[], options.expectedConsumers ?? {}, {
    now: options.now,
    pendingWarningSeconds: options.pendingWarningSeconds,
  });
}
