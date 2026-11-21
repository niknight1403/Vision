import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { retryDelaySeconds, runOutboxWorker, sanitizeOutboxError } from "./outbox-worker.js";

describe("outbox retry policy", () => {
  it("uses bounded exponential backoff", () => {
    expect(retryDelaySeconds(1, 5)).toBe(5);
    expect(retryDelaySeconds(2, 5)).toBe(10);
    expect(retryDelaySeconds(3, 5)).toBe(20);
  });
  it("caps delay and guards extreme attempts", () => {
    expect(retryDelaySeconds(20, 5)).toBe(3600);
    expect(retryDelaySeconds(0, 5)).toBe(5);
  });
  it("redacts credentials from persisted error details", () => {
    expect(sanitizeOutboxError(new Error("Authorization: Bearer abc123 api_key=sk-secret password=hunter2")))
      .toBe("Authorization: [REDACTED] api_key=[REDACTED] password=[REDACTED]");
    expect(sanitizeOutboxError(new Error("request failed https://user:pass@example.test/path")))
      .toBe("request failed https://[REDACTED]@example.test/path");
  });
  it("rejects invalid retry configuration", () => {
    expect(() => retryDelaySeconds(1, 0)).toThrow("INVALID_BASE_RETRY_SECONDS");
    expect(() => retryDelaySeconds(1, Number.NaN)).toThrow("INVALID_BASE_RETRY_SECONDS");
  });
});


describe("outbox worker graceful shutdown", () => {
  it("stops polling after abort while idle", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;
    const controller = new AbortController();

    const running = runOutboxWorker(
      prisma,
      { workerId: "worker-shutdown-idle", pollIntervalMs: 5_000 },
      async () => undefined,
      controller.signal,
    );

    await vi.waitFor(() => expect(queryRaw).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(running).resolves.toEqual({
      published: 0,
      retryScheduled: 0,
      deadLettered: 0,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("drains the active handler and does not claim another event after abort", async () => {
    const event = {
      id: "outbox-shutdown-drain",
      eventType: "test.shutdown.drain",
      aggregateId: "aggregate-shutdown-drain",
      correlationId: null,
      schemaVersion: 1,
      payload: { safe: true },
      attempts: 1,
      claimToken: "worker-shutdown-drain:claim-token",
    };
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([event])
      .mockResolvedValueOnce([{ id: event.id }]);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;
    const controller = new AbortController();
    let handlerFinished = false;

    const summary = await runOutboxWorker(
      prisma,
      { workerId: "worker-shutdown-drain", pollIntervalMs: 250, leaseSeconds: 60 },
      async () => {
        controller.abort();
        await Promise.resolve();
        handlerFinished = true;
      },
      controller.signal,
    );

    expect(handlerFinished).toBe(true);
    expect(summary).toEqual({ published: 1, retryScheduled: 0, deadLettered: 0 });
    // One claim and one fenced acknowledgement; shutdown starts no second claim.
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe polling intervals", async () => {
    const prisma = { $queryRaw: vi.fn() } as unknown as PrismaClient;
    await expect(runOutboxWorker(
      prisma,
      { workerId: "worker-shutdown-invalid", pollIntervalMs: 100 },
      async () => undefined,
      new AbortController().signal,
    )).rejects.toThrow("INVALID_POLL_INTERVAL_MS");
  });
});
