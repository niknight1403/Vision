import { describe, expect, it } from "vitest";
import { applyPaperTradingCosts } from "./research-pipeline.js";
import { assessOutOfSampleRobustness, classifyVolatilityRegime, optimizePaperBacktest, runOptimizedPaperBacktest } from "./backtest-optimization.js";

const base = { version: "v2.0.0", minConfidenceBasisPoints: 6_000, buyThresholdBasisPoints: 2_500, avoidThresholdBasisPoints: -2_000, maxVolatilityScore: 70, feeBasisPoints: 100, slippageBasisPoints: 50, initialCapitalCents: 10_000n, riskPerTradeBasisPoints: 1_000, maxOpenPositions: 1, stopLossBasisPoints: 1_000, takeProfitBasisPoints: 2_000, cooldownBars: 1 };
const bar = (id: string, priceCents: bigint, exitPriceCents: bigint, volatilityScore = 10) => ({ id, observedAt: "2026-01-01T00:00:00.000Z", priceCents, fairValueCents: 140n, demandScore: 90, inventoryScore: 20, volatilityScore, exitPriceCents });

describe("backtest optimization sprints 24-33", () => {
  it("accounts for fees, slippage, targets, and paper-only execution", () => {
    const result = runOptimizedPaperBacktest([bar("win", 100n, 130n), bar("stop", 100n, 80n)], base);
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0]?.exitReason).toBe("TARGET");
    expect(result.trades[1]?.exitReason).toBe("STOP");
    expect(result.trades[0]?.netProfitCents).toBe(applyPaperTradingCosts(100n, 120n, base).netProfitCents);
    expect(result.paperOnly).toBe(true);
    expect(result.liveExecutionEnabled).toBe(false);
  });

  it("produces equity, drawdown, win-rate, and profit-factor metrics", () => {
    const result = runOptimizedPaperBacktest([bar("a", 100n, 130n), bar("b", 100n, 80n)], base);
    expect(result.equityCurve).toHaveLength(2);
    expect(result.maxDrawdownCents).toBeGreaterThan(0n);
    expect(result.winRateBasisPoints).toBe(5_000);
    expect(result.profitFactorBasisPoints).toBeGreaterThan(0n);
  });

  it("enforces optimization input boundaries and duplicate protection", () => {
    expect(() => runOptimizedPaperBacktest([bar("x", 100n, 120n), bar("x", 100n, 120n)], base)).toThrow("OPTIMIZATION_DUPLICATE_BAR");
    expect(() => runOptimizedPaperBacktest([], { ...base, initialCapitalCents: 0n })).toThrow("OPTIMIZATION_CAPITAL_INVALID");
  });

  it("ranks deterministic parameter sweeps and reports robustness", () => {
    const report = optimizePaperBacktest([bar("a", 100n, 130n), bar("b", 100n, 120n)], base, { riskPerTradeBasisPoints: [500, 1_000], stopLossBasisPoints: [1_000], takeProfitBasisPoints: [1_000, 2_000] });
    expect(report.ranked).toHaveLength(4);
    expect(report.ranked[0]?.result.returnBasisPoints).toBeGreaterThanOrEqual(report.ranked[1]?.result.returnBasisPoints ?? 0n);
    expect(report.robustness.candidates).toBe(4);
    expect(report.selectedFingerprint).toHaveLength(8);
  });

  it("evaluates out-of-sample folds instead of only in-sample data", () => {
    const summary = assessOutOfSampleRobustness([bar("a", 100n, 120n), bar("b", 100n, 130n), bar("c", 100n, 80n), bar("d", 100n, 120n), bar("e", 100n, 130n)], base, 2, 1);
    expect(summary.candidates).toBe(3);
    expect(summary.stabilityBasisPoints).toBeGreaterThanOrEqual(0);
  });

  it("classifies volatility regimes with validated thresholds", () => {
    expect(classifyVolatilityRegime(bar("low", 100n, 110n, 20))).toBe("LOW_VOLATILITY");
    expect(classifyVolatilityRegime(bar("high", 100n, 110n, 80))).toBe("HIGH_VOLATILITY");
    expect(() => classifyVolatilityRegime(bar("x", 100n, 110n), 101)).toThrow("REGIME_THRESHOLD_INVALID");
  });
});
