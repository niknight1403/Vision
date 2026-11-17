import { describe, expect, it } from "vitest";
import { compareSessionToMarket, createSessionCheckpoint, simulateLivePaperSession, validatePaperTicks, type PaperSimulationConfig, type PaperTick } from "./live-paper-simulation.js";

const config: PaperSimulationConfig = { version: "v3.0.0", minConfidenceBasisPoints: 6_000, buyThresholdBasisPoints: 2_500, avoidThresholdBasisPoints: -2_000, maxVolatilityScore: 70, feeBasisPoints: 100, slippageBasisPoints: 50, initialCapitalCents: 10_000n, orderNotionalCents: 1_000n, maxLatencyMs: 500, fillRatioBasisPoints: 10_000, maxDrawdownBasisPoints: 2_000, minCashReserveCents: 1_000n };
const tick = (id: string, sequence: number, bidCents: bigint, askCents = bidCents, volatilityScore = 10): PaperTick => ({ id, sequence, observedAt: "2026-01-01T00:00:00.000Z", receivedAt: `2026-01-01T00:00:0${sequence}.000Z`, priceCents: askCents, fairValueCents: sequence === 3 ? 1n : 140n, demandScore: sequence === 3 ? 10 : 90, inventoryScore: 20, volatilityScore, bidCents, askCents, liquidityCents: 10_000n });

describe("live PAPER simulation sprints 34-43", () => {
  it("validates ordered, unique ticks and quote integrity", () => {
    expect(() => validatePaperTicks([tick("a", 1, 100n), tick("a", 2, 100n)])).toThrow("PAPER_TICK_DUPLICATE");
    expect(() => validatePaperTicks([tick("a", 2, 100n), tick("b", 1, 100n)])).toThrow("PAPER_TICK_ORDER_INVALID");
    expect(() => validatePaperTicks([tick("a", 1, 90n, 80n)])).toThrow("PAPER_QUOTE_INVALID");
  });

  it("creates virtual BUY and SELL lifecycle events only", () => {
    const session = simulateLivePaperSession("session-1", [tick("a", 1, 100n), tick("b", 2, 110n), tick("c", 3, 100n)], config);
    expect(session.orders.some((order) => order.side === "BUY" && order.status === "FILLED")).toBe(true);
    expect(session.orders.some((order) => order.side === "SELL" && order.status === "FILLED")).toBe(true);
    expect(session.orders.every((order) => order.id.startsWith("session-1:"))).toBe(true);
    expect(session.liveExecutionEnabled).toBe(false);
  });

  it("keeps a cash reserve and rejects virtual orders when needed", () => {
    const constrained = simulateLivePaperSession("reserve", [tick("a", 1, 100n)], { ...config, initialCapitalCents: 1_500n, minCashReserveCents: 1_500n });
    expect(constrained.orders[0]?.status).toBe("REJECTED");
    expect(constrained.alerts[0]?.code).toBe("ORDER_REJECTED_CASH_RESERVE");
  });

  it("produces mark-to-market equity, drawdown, and critical alerts", () => {
    const session = simulateLivePaperSession("risk", [tick("a", 1, 100n), tick("b", 2, 70n, 70n, 90)], { ...config, maxDrawdownBasisPoints: 1 });
    expect(session.equityCurve).toHaveLength(2);
    expect(session.maxDrawdownCents).toBeGreaterThan(0n);
    expect(session.alerts.some((alert) => alert.code === "MAX_DRAWDOWN_EXCEEDED")).toBe(true);
  });

  it("compares session performance to a market midpoint benchmark", () => {
    const session = simulateLivePaperSession("benchmark", [tick("a", 1, 100n), tick("b", 2, 110n), tick("c", 3, 100n)], config);
    const benchmark = compareSessionToMarket(session, 100n, 110n);
    expect(benchmark.marketReturnBasisPoints).toBe(1_000n);
    expect(benchmark.paperOnly).toBe(true);
  });

  it("creates reproducible checkpoints for replay and auditing", () => {
    const session = simulateLivePaperSession("checkpoint", [tick("a", 1, 100n), tick("b", 2, 110n)], config);
    const checkpoint = createSessionCheckpoint(session, 2);
    expect(checkpoint.sessionId).toBe("checkpoint");
    expect(checkpoint.fingerprint).toHaveLength(8);
    expect(checkpoint.paperOnly).toBe(true);
    expect(() => createSessionCheckpoint(session, 99)).toThrow("SESSION_CHECKPOINT_NOT_FOUND");
  });
});
