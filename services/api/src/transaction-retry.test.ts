import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { runSerializableTransaction } from "./transaction-retry.js";

function serializationConflict() {
  return new Prisma.PrismaClientKnownRequestError("serialization conflict", {
    code: "P2034",
    clientVersion: "test",
  });
}

describe("runSerializableTransaction", () => {
  it("retries the entire transaction after a serialization conflict", async () => {
    let attempts = 0;
    const tx = {} as Prisma.TransactionClient;
    const prisma = {
      $transaction: vi.fn(async (operation: (client: Prisma.TransactionClient) => Promise<string>) => {
        attempts += 1;
        if (attempts === 1) throw serializationConflict();
        return operation(tx);
      }),
    } as unknown as PrismaClient;

    await expect(runSerializableTransaction(prisma, async () => "committed", {
      maxAttempts: 3,
      baseDelayMs: 0,
    })).resolves.toBe("committed");
    expect(attempts).toBe(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it("does not retry non-serialization errors", async () => {
    const failure = new Error("business validation failed");
    const prisma = {
      $transaction: vi.fn(async () => { throw failure; }),
    } as unknown as PrismaClient;

    await expect(runSerializableTransaction(prisma, async () => "never", {
      baseDelayMs: 0,
    })).rejects.toBe(failure);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("surfaces the final serialization conflict after the attempt limit", async () => {
    const failure = serializationConflict();
    const prisma = {
      $transaction: vi.fn(async () => { throw failure; }),
    } as unknown as PrismaClient;

    await expect(runSerializableTransaction(prisma, async () => "never", {
      maxAttempts: 2,
      baseDelayMs: 0,
    })).rejects.toBe(failure);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe retry configuration", async () => {
    const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;
    await expect(runSerializableTransaction(prisma, async () => "never", {
      maxAttempts: 0,
    })).rejects.toThrow("INVALID_SERIALIZABLE_RETRY_ATTEMPTS");
    await expect(runSerializableTransaction(prisma, async () => "never", {
      baseDelayMs: Number.POSITIVE_INFINITY,
    })).rejects.toThrow("INVALID_SERIALIZABLE_RETRY_DELAY");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
