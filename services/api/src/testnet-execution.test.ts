import { describe, expect, it } from "vitest";
import { DisabledTestnetAdapter, evaluateExecutionGate, evaluateKillSwitch, makeClientOrderId, reconcileOrders, transitionOrderStatus, validateApproval, type OrderIntent } from "./testnet-execution.js";

const approval = { intentId: "intent-1", payloadHash: "hash-1", environment: "TESTNET" as const, providerId: "sandbox", accountId: "account-1", instrument: "DEMO-EUR", side: "BUY" as const, quantity: 2n, limitPriceCents: 100n, feeLimitCents: 5n, expiresAt: "2026-12-01T00:00:00.000Z", approvedBy: "admin-1" };
const intent: OrderIntent = { id: "intent-1", idempotencyKey: "idem-1", payloadHash: "hash-1", environment: "TESTNET", providerId: "sandbox", accountId: "account-1", status: "APPROVED", approval };

describe("safe testnet execution primitives", () => {
  it("allows only declared order state transitions", () => {
    expect(transitionOrderStatus("DRAFT", "APPROVED")).toBe("APPROVED");
    expect(transitionOrderStatus("UNKNOWN", "SUBMITTED")).toBe("SUBMITTED");
    expect(() => transitionOrderStatus("FILLED", "SUBMITTED")).toThrow("ORDER_TRANSITION_NOT_ALLOWED");
  });

  it("requires a non-expired TESTNET approval snapshot", () => {
    validateApproval(approval, "2026-11-01T00:00:00.000Z");
    expect(() => validateApproval({ ...approval, environment: "TESTNET", expiresAt: "2026-01-01T00:00:00.000Z" }, "2026-11-01T00:00:00.000Z")).toThrow("APPROVAL_EXPIRED");
  });

  it("blocks execution on emergency stop or any non-armed scope", () => {
    expect(evaluateKillSwitch([{ scope: "GLOBAL", state: "ARMED" }]).acceptsNewOrders).toBe(true);
    expect(evaluateKillSwitch([{ scope: "GLOBAL", state: "TRIGGERED" }])).toEqual({ acceptsNewOrders: false, reason: "KILL_SWITCH_GLOBAL_TRIGGERED" });
    expect(() => evaluateExecutionGate({ intent, capabilities: ["ORDER_SUBMIT"], killSwitches: [{ scope: "GLOBAL", state: "ARMED" }], now: "2026-11-01T00:00:00.000Z", emergencyStop: true })).toThrow("EMERGENCY_STOP_ACTIVE");
    expect(() => evaluateExecutionGate({ intent, capabilities: [], killSwitches: [{ scope: "GLOBAL", state: "ARMED" }], now: "2026-11-01T00:00:00.000Z", emergencyStop: false })).toThrow("PROVIDER_ORDER_SUBMIT_UNAVAILABLE");
  });

  it("keeps the default provider adapter disabled", async () => {
    const adapter = new DisabledTestnetAdapter();
    expect(adapter.capabilities).toEqual([]);
    await expect(adapter.submitOrder({ clientOrderId: "x", instrument: "DEMO", side: "BUY", quantity: 1n, limitPriceCents: 1n })).rejects.toThrow("TESTNET_ADAPTER_DISABLED");
    await expect(adapter.queryOrders([])).rejects.toThrow("TESTNET_ADAPTER_DISABLED");
  });

  it("creates stable client order identifiers", () => {
    expect(makeClientOrderId("TESTNET", "account-1", "intent-1")).toBe("aa-testnet-account-1-intent-1-v1");
    expect(() => makeClientOrderId("TESTNET", "", "intent-1")).toThrow("CLIENT_ORDER_ID_INPUT_INVALID");
  });

  it("halts on unknown external orders and clears matching snapshots", () => {
    const clean = reconcileOrders([{ intentId: "intent-1", clientOrderId: "client-1", status: "SUBMITTED", filledQuantity: 0n, feeCents: 0n, providerOrderId: "provider-1" }], [{ clientOrderId: "client-1", providerOrderId: "provider-1", status: "OPEN", filledQuantity: 0n, averagePriceCents: null, feeCents: 0n }]);
    expect(clean.status).toBe("CLEAN");
    const halted = reconcileOrders([{ intentId: "intent-1", clientOrderId: "client-1", status: "SUBMITTED", filledQuantity: 0n, feeCents: 0n, providerOrderId: null }], [{ clientOrderId: "unknown", providerOrderId: "provider-2", status: "OPEN", filledQuantity: 0n, averagePriceCents: null, feeCents: 0n }]);
    expect(halted.status).toBe("HALT_REQUIRED");
    expect(halted.diffs.map((diff) => diff.kind)).toEqual(["UNKNOWN_INTERNAL_ORDER", "UNMATCHED_EXTERNAL_ORDER"]);
  });
});
