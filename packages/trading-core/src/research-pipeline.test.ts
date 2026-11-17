import { describe, expect, it } from "vitest";
import { generateStrategySignal } from "./strategy-signals.js";
import { runPaperBacktest } from "./strategy-backtest.js";
import {
  applyPaperTradingCosts,
  calculatePaperPositionSize,
  checkPaperExposure,
  combinePaperSignals,
  compareToBuyAndHold,
  createWalkForwardSplits,
  fingerprintResearchInput,
  runPaperResearch,
  validateStrategyConfig,
} from "./research-pipeline.js";

const config = { version: "v1.0.0", minConfidenceBasisPoints: 6_000, buyThresholdBasisPoints: 2_500, avoidThresholdBasisPoints: -2_000, maxVolatilityScore: 70, feeBasisPoints: 100, slippageBasisPoints: 50 };
const observation = (id: string, priceCents = 100n) => ({ id, observedAt: "2026-01-01T00:00:00.000Z", priceCents, fairValueCents: 140n, demandScore: 90, inventoryScore: 20, volatilityScore: 10 });

describe("research sprints 14-23", () => {
  it("validates semantic strategy versions and cost bounds", () => {
    expect(validateStrategyConfig(config).version).toBe("v1.0.0");
    expect(() => validateStrategyConfig({ ...config, version: "latest" })).toThrow("STRATEGY_VERSION_INVALID");
    expect(() => validateStrategyConfig({ ...config, feeBasisPoints: 1_900, slippageBasisPoints: 200 })).toThrow("STRATEGY_COST_CONFIG_INVALID");
  });

  it("combines weighted model votes transparently", () => {
    const first = generateStrategySignal(observation("x"));
    const second = generateStrategySignal({ ...observation("x"), demandScore: 60 });
    const ensemble = combinePaperSignals([{ model: "value", signal: first, weight: 2 }, { model: "demand", signal: second, weight: 1 }]);
    expect(ensemble.votes).toHaveLength(2);
    expect(ensemble.paperOnly).toBe(true);
    expect(ensemble.liveExecutionEnabled).toBe(false);
  });

  it("models fees and slippage in integer cents", () => {
    const outcome = applyPaperTradingCosts(1_000n, 1_200n, config);
    expect(outcome.grossProfitCents).toBe(200n);
    expect(outcome.feeCents).toBe(22n);
    expect(outcome.slippageCents).toBe(11n);
    expect(outcome.netProfitCents).toBe(167n);
  });

  it("caps paper position size by risk, capital, and max units", () => {
    const size = calculatePaperPositionSize({ capitalCents: 1_000n, riskBudgetCents: 100n, entryPriceCents: 100n, stopLossBasisPoints: 1_000, maxUnits: 20n });
    expect(size.units).toBe(10n);
    expect(size.riskCents).toBe(100n);
    expect(size.paperOnly).toBe(true);
  });

  it("reports total and category exposure breaches", () => {
    expect(checkPaperExposure([{ id: "a", notionalCents: 700n, category: "electronics" }, { id: "b", notionalCents: 500n, category: "electronics" }], { maxTotalCents: 1_000n, maxCategoryCents: 1_000n })).toEqual(["MAX_TOTAL_EXPOSURE_EXCEEDED", "MAX_CATEGORY_EXPOSURE_EXCEEDED:electronics"]);
  });

  it("creates non-overlapping walk-forward windows", () => {
    const splits = createWalkForwardSplits([1, 2, 3, 4, 5, 6, 7, 8], 3, 2, 2);
    expect(splits).toEqual([{ train: [1, 2, 3], test: [4, 5] }, { train: [3, 4, 5], test: [6, 7] }]);
  });

  it("compares the strategy result to a buy-and-hold benchmark", () => {
    const result = runPaperBacktest([{ ...observation("a"), exitPriceCents: 120n }], 1_000n);
    const benchmark = compareToBuyAndHold(result, 100n, 110n);
    expect(benchmark.strategyReturnBasisPoints).toBe(200n);
    expect(benchmark.buyAndHoldReturnBasisPoints).toBe(1_000n);
    expect(benchmark.excessReturnBasisPoints).toBe(-800n);
  });

  it("produces stable input fingerprints", () => {
    expect(fingerprintResearchInput("abc")).toBe(fingerprintResearchInput("abc"));
    expect(fingerprintResearchInput("abc")).not.toBe(fingerprintResearchInput("abd"));
    expect(() => fingerprintResearchInput("")).toThrow("RESEARCH_INPUT_EMPTY");
  });

  it("composes a complete PAPER research run", () => {
    const run = runPaperResearch([observation("a")], [{ ...observation("a"), exitPriceCents: 120n }], config, 1_000n);
    expect(run.configVersion).toBe("v1.0.0");
    expect(run.inputFingerprint).toHaveLength(8);
    expect(run.backtest.trades).toHaveLength(1);
    expect(run.liveExecutionEnabled).toBe(false);
  });

  it("rejects data leakage windows that cannot form a test set", () => {
    expect(() => createWalkForwardSplits([1, 2], 2, 1)).toThrow("WALK_FORWARD_DATASET_TOO_SMALL");
  });
});
