import { Prisma, PrismaClient } from "@prisma/client";

export type SerializableRetryOptions = {
  /** Total transaction attempts, including the first attempt. */
  maxAttempts?: number;
  /** Linear delay base; zero keeps tests and controlled jobs deterministic. */
  baseDelayMs?: number;
};

function isSerializationConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === "P2034";
  // Preserve retry behavior across Prisma client/runtime package boundaries,
  // where instanceof may not match even though the documented error code does.
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "P2034";
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
