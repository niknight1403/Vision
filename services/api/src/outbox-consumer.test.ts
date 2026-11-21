import { describe, expect, it, vi } from "vitest";
import { OutboxConsumerRegistry } from "./outbox-consumer.js";
import type { OutboxMessage } from "./outbox-worker.js";

const message = (overrides: Partial<OutboxMessage> = {}): OutboxMessage => ({
  id: "evt-1", eventType: "wallet.reservation.created", aggregateId: "wallet-1",
  correlationId: null, schemaVersion: 1, payload: { amountCents: "250" }, attempts: 1,
  ...overrides,
});

describe("versioned outbox consumer registry", () => {
  it("dispatches only the exact registered event schema version", async () => {
    const v1 = vi.fn(async () => undefined);
    const v2 = vi.fn(async () => undefined);
    const registry = new OutboxConsumerRegistry()
      .register("wallet.reservation.created", 1, v1)
      .register("wallet.reservation.created", 2, v2);

    await registry.dispatch(message({ schemaVersion: 2 }));
    expect(v2).toHaveBeenCalledOnce();
    expect(v1).not.toHaveBeenCalled();
  });

  it("fails closed for unknown event types and schema versions", async () => {
    const sideEffect = vi.fn(async () => undefined);
    const registry = new OutboxConsumerRegistry().register("wallet.reservation.created", 1, sideEffect);
    await expect(registry.dispatch(message({ schemaVersion: 3 })))
      .rejects.toThrow("OUTBOX_UNSUPPORTED_SCHEMA_VERSION:wallet.reservation.created:v3");
    await expect(registry.dispatch(message({ eventType: "wallet.unknown" })))
      .rejects.toThrow("OUTBOX_UNSUPPORTED_SCHEMA_VERSION:wallet.unknown:v1");
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("rejects duplicate registrations and invalid versions", () => {
    const registry = new OutboxConsumerRegistry().register("event.test", 1, async () => undefined);
    expect(() => registry.register("event.test", 1, async () => undefined))
      .toThrow("OUTBOX_CONSUMER_VERSION_ALREADY_REGISTERED");
    expect(() => registry.register("event.test", 0, async () => undefined))
      .toThrow("OUTBOX_CONSUMER_SCHEMA_VERSION_INVALID");
  });
});
