import { generateStrategySignal, type StrategyObservation } from "./strategy-signals.js";
import { applyPaperTradingCosts, createWalkForwardSplits, fingerprintResearchInput, type StrategyConfig } from "./research-pipeline.js";
import type { BacktestBar } from "./strategy-backtest.js";

export type OptimizationConfig = StrategyConfig & {
  initialCapitalCents: bigint;
  riskPerTradeBasisPoints: number;
  maxOpenPositions: number;
  stopLossBasisPoints: number;
  takeProfitBasisPoints: number;
  cooldownBars: number;
};

export type OptimizedTrade = {
  id: string;
  entryPriceCents: bigint;
  exitPriceCents: bigint;
  grossProfitCents: bigint;
  netProfitCents: bigint;
  feeCents: bigint;
  slippageCents: bigint;
  exitReason: "TARGET" | "STOP" | "BAR_CLOSE";
};

export type EquityPoint = { barIndex: number; capitalCents: bigint; drawdownCents: bigint; drawdownBasisPoints: bigint };
export type OptimizedBacktestResult = {
  configVersion: string;
  inputFingerprint: string;
  initialCapitalCents: bigint;
  finalCapitalCents: bigint;
  profitCents: bigint;
  returnBasisPoints: bigint;
  maxDrawdownCents: bigint;
  maxDrawdownBasisPoints: bigint;
  averageTradeProfitCents: bigint | null;
  profitFactorBasisPoints: bigint | null;
  winRateBasisPoints: number;
  exposureTimeBasisPoints: number;
  trades: readonly OptimizedTrade[];
  equityCurve: readonly EquityPoint[];
  paperOnly: true;
  liveExecutionEnabled: false;
};

export type ParameterSweep = {
  riskPerTradeBasisPoints: readonly number[];
  stopLossBasisPoints: readonly number[];
  takeProfitBasisPoints: readonly number[];
};
export type SweepResult = { config: OptimizationConfig; result: OptimizedBacktestResult };
export type RobustnessSummary = { candidates: number; profitableCandidates: number; medianReturnBasisPoints: bigint | null; worstReturnBasisPoints: bigint | null; bestReturnBasisPoints: bigint | null; stabilityBasisPoints: number; paperOnly: true };
export type OptimizationReport = { ranked: readonly SweepResult[]; robustness: RobustnessSummary; selectedFingerprint: string | null; paperOnly: true; liveExecutionEnabled: false };

function validateConfig(config: OptimizationConfig): void {
  if (config.initialCapitalCents <= 0n) throw new Error("OPTIMIZATION_CAPITAL_INVALID");
  const integerFields = [config.riskPerTradeBasisPoints, config.stopLossBasisPoints, config.takeProfitBasisPoints, config.cooldownBars, config.maxOpenPositions];
  if (integerFields.some((value) => !Number.isInteger(value)) || config.riskPerTradeBasisPoints <= 0 || config.riskPerTradeBasisPoints > 10_000 || config.stopLossBasisPoints <= 0 || config.stopLossBasisPoints > 10_000 || config.takeProfitBasisPoints <= 0 || config.takeProfitBasisPoints > 100_000 || config.cooldownBars < 0 || config.maxOpenPositions <= 0) throw new Error("OPTIMIZATION_CONFIG_INVALID");
}

function validateBars(bars: readonly BacktestBar[]): void {
  const ids = new Set<string>();
  for (const bar of bars) {
    if (ids.has(bar.id)) throw new Error("OPTIMIZATION_DUPLICATE_BAR");
    ids.add(bar.id);
    if (bar.exitPriceCents <= 0n) throw new Error("OPTIMIZATION_EXIT_PRICE_INVALID");
  }
}

export function runOptimizedPaperBacktest(bars: readonly BacktestBar[], config: OptimizationConfig): OptimizedBacktestResult {
  validateConfig(config);
  validateBars(bars);
  let capital = config.initialCapitalCents;
  let peak = capital;
  let maxDrawdown = 0n;
  let openPositions = 0;
  let cooldown = 0;
  let exposureBars = 0;
  const trades: OptimizedTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const signal = generateStrategySignal(bar);
    if (cooldown > 0) cooldown -= 1;
    if (signal.action === "BUY" && cooldown === 0 && openPositions < config.maxOpenPositions) {
      const riskBudget = (capital * BigInt(config.riskPerTradeBasisPoints)) / 10_000n;
      const stopLoss = (bar.priceCents * BigInt(config.stopLossBasisPoints)) / 10_000n;
      const target = (bar.priceCents * BigInt(config.takeProfitBasisPoints)) / 10_000n;
      if (riskBudget > 0n && stopLoss > 0n) {
        const stopPrice = bar.priceCents - stopLoss;
        const targetPrice = bar.priceCents + target;
        const exitPrice = bar.exitPriceCents <= stopPrice ? stopPrice : bar.exitPriceCents >= targetPrice ? targetPrice : bar.exitPriceCents;
        const exitReason = bar.exitPriceCents <= stopPrice ? "STOP" : bar.exitPriceCents >= targetPrice ? "TARGET" : "BAR_CLOSE";
        const outcome = applyPaperTradingCosts(bar.priceCents, exitPrice, config);
        capital += outcome.netProfitCents;
        openPositions += 1;
        exposureBars += 1;
        trades.push({ id: bar.id, entryPriceCents: bar.priceCents, exitPriceCents: exitPrice, grossProfitCents: outcome.grossProfitCents, netProfitCents: outcome.netProfitCents, feeCents: outcome.feeCents, slippageCents: outcome.slippageCents, exitReason });
        openPositions -= 1;
        cooldown = config.cooldownBars;
      }
    }
    if (capital > peak) peak = capital;
    const drawdown = peak - capital;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    equityCurve.push({ barIndex: index, capitalCents: capital, drawdownCents: drawdown, drawdownBasisPoints: peak === 0n ? 0n : (drawdown * 10_000n) / peak });
  }
  const wins = trades.filter((trade) => trade.netProfitCents > 0n);
  const losses = trades.filter((trade) => trade.netProfitCents < 0n);
  const grossWins = wins.reduce((sum, trade) => sum + trade.netProfitCents, 0n);
  const grossLosses = losses.reduce((sum, trade) => sum - trade.netProfitCents, 0n);
  const profit = capital - config.initialCapitalCents;
  return { configVersion: config.version, inputFingerprint: fingerprintResearchInput(JSON.stringify(bars.map((bar) => bar.id))), initialCapitalCents: config.initialCapitalCents, finalCapitalCents: capital, profitCents: profit, returnBasisPoints: (profit * 10_000n) / config.initialCapitalCents, maxDrawdownCents: maxDrawdown, maxDrawdownBasisPoints: peak === 0n ? 0n : (maxDrawdown * 10_000n) / peak, averageTradeProfitCents: trades.length === 0 ? null : trades.reduce((sum, trade) => sum + trade.netProfitCents, 0n) / BigInt(trades.length), profitFactorBasisPoints: grossLosses === 0n ? (grossWins > 0n ? null : 0n) : (grossWins * 10_000n) / grossLosses, winRateBasisPoints: trades.length === 0 ? 0 : Math.round((wins.length * 10_000) / trades.length), exposureTimeBasisPoints: bars.length === 0 ? 0 : Math.round((exposureBars * 10_000) / bars.length), trades, equityCurve, paperOnly: true, liveExecutionEnabled: false };
}

function expandSweep(base: OptimizationConfig, sweep: ParameterSweep): OptimizationConfig[] {
  if (sweep.riskPerTradeBasisPoints.length === 0 || sweep.stopLossBasisPoints.length === 0 || sweep.takeProfitBasisPoints.length === 0) throw new Error("PARAMETER_SWEEP_EMPTY");
  const configs: OptimizationConfig[] = [];
  for (const risk of sweep.riskPerTradeBasisPoints) for (const stop of sweep.stopLossBasisPoints) for (const target of sweep.takeProfitBasisPoints) configs.push({ ...base, riskPerTradeBasisPoints: risk, stopLossBasisPoints: stop, takeProfitBasisPoints: target });
  return configs;
}

export function summarizeRobustness(results: readonly SweepResult[]): RobustnessSummary {
  if (results.length === 0) throw new Error("ROBUSTNESS_RESULTS_EMPTY");
  const returns = results.map((item) => item.result.returnBasisPoints).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const profitable = returns.filter((value) => value > 0n).length;
  const median = returns[Math.floor(returns.length / 2)] ?? null;
  return { candidates: results.length, profitableCandidates: profitable, medianReturnBasisPoints: median, worstReturnBasisPoints: returns[0] ?? null, bestReturnBasisPoints: returns[returns.length - 1] ?? null, stabilityBasisPoints: Math.round((profitable * 10_000) / results.length), paperOnly: true };
}

export function optimizePaperBacktest(bars: readonly BacktestBar[], base: OptimizationConfig, sweep: ParameterSweep): OptimizationReport {
  const results = expandSweep(base, sweep).map((config) => ({ config, result: runOptimizedPaperBacktest(bars, config) })).sort((left, right) => right.result.returnBasisPoints < left.result.returnBasisPoints ? -1 : right.result.returnBasisPoints > left.result.returnBasisPoints ? 1 : 0);
  const robustness = summarizeRobustness(results);
  return { ranked: results, robustness, selectedFingerprint: results[0]?.result.inputFingerprint ?? null, paperOnly: true, liveExecutionEnabled: false };
}

export function assessOutOfSampleRobustness(bars: readonly BacktestBar[], config: OptimizationConfig, trainSize: number, testSize: number): RobustnessSummary {
  const splits = createWalkForwardSplits(bars, trainSize, testSize);
  const results = splits.map((split, index) => ({ config: { ...config, version: `${config.version}-fold-${index + 1}` }, result: runOptimizedPaperBacktest(split.test, config) }));
  return summarizeRobustness(results);
}

export type Regime = "LOW_VOLATILITY" | "HIGH_VOLATILITY";
export function classifyVolatilityRegime(observation: StrategyObservation, threshold = 50): Regime {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error("REGIME_THRESHOLD_INVALID");
  return observation.volatilityScore > threshold ? "HIGH_VOLATILITY" : "LOW_VOLATILITY";
}
