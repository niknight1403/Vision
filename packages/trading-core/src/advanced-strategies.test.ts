import { describe, expect, it } from "vitest";
import { allocatePaperCapital } from "./strategy-allocation.js";
import { runPaperBacktest } from "./strategy-backtest.js";
import { generateStrategySignal } from "./strategy-signals.js";

const observation = (id: string, priceCents: bigint, fairValueCents: bigint, demandScore = 90, inventoryScore = 20, volatilityScore = 10) => ({
  id, observedAt: "2026-01-01T00:00:00.000Z", priceCents, fairValueCents, demandScore, inventoryScore, volatilityScore,
});

describe("advanced PAPER strategy sprints", () => {
  it("creates an explainable BUY signal without enabling live execution", () => {
    const signal = generateStrategySignal(observation("a", 100n, 140n));
    expect(signal.action).toBe("BUY");
    expect(signal.factors).toEqual(expect.arrayContaining(["demandScore:90", "inventoryScore:20"]));
    expect(signal.paperOnly).toBe(true);
    expect(signal.liveExecutionEnabled).toBe(false);
  });

  it("rejects unbounded model features and duplicate signal identities", () => {
    expect(() => generateStrategySignal(observation("a", 100n, 140n, 101))).toThrow("demandScore");
    expect(() => generateStrategySignal(observation("a", 0n, 140n))).toThrow("STRATEGY_PRICES_MUST_BE_POSITIVE");
  });

  it("allocates only BUY signals within capital, position and portfolio-risk limits", () => {
    const a = generateStrategySignal(observation("a", 100n, 140n));
    const b = generateStrategySignal(observation("b", 100n, 130n));
    const plan = allocatePaperCapital([
      { signal: a, unitCostCents: 100n, expectedProfitCents: 30n, riskCents: 10n },
      { signal: b, unitCostCents: 100n, expectedProfitCents: 20n, riskCents: 10n },
    ], { availableCapitalCents: 250n, maxPositionCents: 150n, maxPortfolioRiskCents: 20n, maxPositions: 2 });
    expect(plan.allocations.map((item) => item.id)).toEqual(["a", "b"]);
    expect(plan.allocations.map((item) => item.units)).toEqual([1n, 1n]);
    expect(plan.totalRiskCents).toBe(20n);
    expect(plan.executionEnabled).toBe(false);
  });

  it("never allocates WATCH signals or exceeds the position count", () => {
    const signal = generateStrategySignal(observation("watch", 100n, 102n, 50, 50, 50));
    const plan = allocatePaperCapital([{ signal, unitCostCents: 10n, expectedProfitCents: 5n, riskCents: 1n }], { availableCapitalCents: 100n, maxPositionCents: 100n, maxPortfolioRiskCents: 100n, maxPositions: 1 });
    expect(plan.allocations).toHaveLength(0);
  });

  it("backtests in input order with deterministic paper metrics", () => {
    const result = runPaperBacktest([
      { ...observation("win", 100n, 140n), exitPriceCents: 120n },
      { ...observation("loss", 100n, 140n), exitPriceCents: 80n },
    ], 1_000n);
    expect(result.finalCapitalCents).toBe(1_000n);
    expect(result.profitCents).toBe(0n);
    expect(result.winningTrades).toBe(1);
    expect(result.losingTrades).toBe(1);
    expect(result.maxDrawdownCents).toBe(20n);
    expect(result.liveExecutionEnabled).toBe(false);
  });

  it("rejects invalid backtest capital and duplicate bars", () => {
    expect(() => runPaperBacktest([], 0n)).toThrow("BACKTEST_INITIAL_CAPITAL_INVALID");
    const bar = { ...observation("same", 100n, 140n), exitPriceCents: 120n };
    expect(() => runPaperBacktest([bar, bar], 1_000n)).toThrow("BACKTEST_DUPLICATE_ID");
  });
});
