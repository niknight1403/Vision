import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { enqueueOutboxEvent } from "./outbox-service.js";

describe("outbox producer contract", () => {
  it("writes a normalized event through the caller transaction with schema v1 by default", async () => {
    const create = vi.fn().mockResolvedValue({ id: "event-1" });
    const tx = { outboxEvent: { create } } as unknown as Prisma.TransactionClient;

    await enqueueOutboxEvent(tx, {
      eventType: "  agent.task.created  ",
      aggregateId: " task-1 ",
      payload: { taskId: "task-1" },
    });

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      data: {
        eventType: "agent.task.created",
        aggregateId: "task-1",
        correlationId: undefined,
        schemaVersion: 1,
        payload: { taskId: "task-1" },
        availableAt: undefined,
      },
    });
  });

  it("preserves explicit schema version, correlation id and availability", async () => {
    const create = vi.fn().mockResolvedValue({ id: "event-2" });
    const tx = { outboxEvent: { create } } as unknown as Prisma.TransactionClient;
    const availableAt = new Date("2026-11-21T12:00:00.000Z");

    await enqueueOutboxEvent(tx, {
      eventType: "wallet.reservation.created",
      aggregateId: "wallet-1",
      correlationId: "corr-1",
      schemaVersion: 2,
      payload: { amountCents: "100" },
      availableAt,
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        eventType: "wallet.reservation.created",
        aggregateId: "wallet-1",
        correlationId: "corr-1",
        schemaVersion: 2,
        payload: { amountCents: "100" },
        availableAt,
      },
    });
  });

  it("rejects missing identity fields and invalid schema versions before writing", async () => {
    const create = vi.fn();
    const tx = { outboxEvent: { create } } as unknown as Prisma.TransactionClient;

    await expect(enqueueOutboxEvent(tx, {
      eventType: " ",
      aggregateId: "task-1",
      payload: {},
    })).rejects.toThrow("OUTBOX_REQUIRED_FIELDS_MISSING");
    await expect(enqueueOutboxEvent(tx, {
      eventType: "agent.task.created",
      aggregateId: " ",
      payload: {},
    })).rejects.toThrow("OUTBOX_REQUIRED_FIELDS_MISSING");
    await expect(enqueueOutboxEvent(tx, {
      eventType: "agent.task.created",
      aggregateId: "task-1",
      schemaVersion: 0,
      payload: {},
    })).rejects.toThrow("OUTBOX_SCHEMA_VERSION_INVALID");
    expect(create).not.toHaveBeenCalled();
  });
});
