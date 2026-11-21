import { Prisma, PrismaClient } from "@prisma/client";

export type SerializableRetryOptions = {
  /** Total transaction attempts, including the first attempt. */
  maxAttempts?: number;
  /** Linear delay base; zero keeps tests and controlled jobs deterministic. */
  baseDelayMs?: number;
};

function isSerializationConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown; message?: unknown };
  };

  // Prisma reports ORM-level serialization/deadlock conflicts as P2034.
  if (candidate.code === "P2034") return true;

  // PostgreSQL SQLSTATE 40001 raised by parameterized $queryRaw calls is
  // wrapped by Prisma as P2010 with the database code in meta.code.
  return candidate.code === "P2010" && candidate.meta?.code === "40001";
}

/**
 * Retries the complete caller-owned database transaction on Prisma serialization
 * conflicts. The callback can run more than once: keep it database-only and put
 * remote effects behind a transactional outbox.
 */
export async function runSerializableTransaction<T>(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  options: SerializableRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 50;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("INVALID_SERIALIZABLE_RETRY_ATTEMPTS");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 5_000) {
    throw new Error("INVALID_SERIALIZABLE_RETRY_DELAY");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === maxAttempts) throw error;
      const delayMs = baseDelayMs * attempt;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("SERIALIZABLE_RETRY_EXHAUSTED");
}
