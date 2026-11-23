import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { processOutboxEventInTransaction } from "./outbox-inbox.js";
import type { OutboxMessage } from "./outbox-worker.js";

const message: OutboxMessage = {
  id: "evt-input-contract",
  eventType: "test.inbox.input",
  aggregateId: "aggregate-1",
  correlationId: null,
  schemaVersion: 1,
  payload: { test: true },
  attempts: 1,
};

function transaction(createMany = vi.fn(async () => ({ count: 1 }))) {
  const tx = {
    outboxConsumerReceipt: { createMany },
  } as unknown as Prisma.TransactionClient;
  return { tx, createMany };
}

describe("transactional outbox inbox input contract", () => {
  it("trims the consumer name and uses conflict-safe receipt insertion", async () => {
    const { tx, createMany } = transaction();
    const handler = vi.fn(async () => undefined);

    const result = await processOutboxEventInTransaction(
      tx,
      "  billing-projection  ",
      message,
      handler,
    );

    expect(result).toBe("PROCESSED");
    expect(createMany).toHaveBeenCalledWith({
      data: [{ consumerName: "billing-projection", eventId: message.id }],
      skipDuplicates: true,
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(["", "   ", "x".repeat(129)])(
    "rejects invalid consumer names before touching the receipt table",
    async (consumerName) => {
      const { tx, createMany } = transaction();
      const handler = vi.fn(async () => undefined);

      await expect(
        processOutboxEventInTransaction(tx, consumerName, message, handler),
      ).rejects.toThrow("OUTBOX_CONSUMER_NAME_INVALID");

      expect(createMany).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("rejects a blank event ID before touching the receipt table", async () => {
    const { tx, createMany } = transaction();
    const handler = vi.fn(async () => undefined);

    await expect(
      processOutboxEventInTransaction(tx, "projection", { ...message, id: "  " }, handler),
    ).rejects.toThrow("OUTBOX_EVENT_ID_REQUIRED");

    expect(createMany).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not invoke the handler when a receipt already exists", async () => {
    const { tx, createMany } = transaction(vi.fn(async () => ({ count: 0 })));
    const handler = vi.fn(async () => undefined);

    const result = await processOutboxEventInTransaction(
      tx,
      "projection",
      message,
      handler,
    );

    expect(result).toBe("DUPLICATE");
    expect(handler).not.toHaveBeenCalled();
  });
});
