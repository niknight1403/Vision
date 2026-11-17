import { generateStrategySignal, type StrategyAction, type StrategyObservation, type StrategySignal } from "./strategy-signals.js";
import { runPaperBacktest, type BacktestBar, type BacktestResult } from "./strategy-backtest.js";

export type StrategyConfig = {
  version: string;
  minConfidenceBasisPoints: number;
  buyThresholdBasisPoints: number;
  avoidThresholdBasisPoints: number;
  maxVolatilityScore: number;
  feeBasisPoints: number;
  slippageBasisPoints: number;
};

export function validateStrategyConfig(config: StrategyConfig): StrategyConfig {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(config.version)) throw new Error("STRATEGY_VERSION_INVALID");
  const nonNegative = [config.minConfidenceBasisPoints, config.maxVolatilityScore];
  const thresholds = [config.buyThresholdBasisPoints, config.avoidThresholdBasisPoints];
  if (nonNegative.some((value) => !Number.isInteger(value) || value < 0 || value > 10_000) || thresholds.some((value) => !Number.isInteger(value) || value < -10_000 || value > 10_000)) throw new Error("STRATEGY_CONFIG_BOUNDS_INVALID");
  if (config.feeBasisPoints < 0 || config.slippageBasisPoints < 0 || config.feeBasisPoints + config.slippageBasisPoints > 2_000) throw new Error("STRATEGY_COST_CONFIG_INVALID");
  return { ...config };
}

export type EnsembleVote = { model: string; signal: StrategySignal; weight: number };
export type EnsembleSignal = { id: string; action: StrategyAction; scoreBasisPoints: number; confidenceBasisPoints: number; votes: readonly EnsembleVote[]; paperOnly: true; liveExecutionEnabled: false };

/** Combines independently labelled PAPER signals without hiding the component votes. */
export function combinePaperSignals(votes: readonly EnsembleVote[]): EnsembleSignal {
  if (votes.length === 0) throw new Error("ENSEMBLE_REQUIRES_VOTES");
  const id = votes[0]!.signal.id;
  if (votes.some((vote) => !vote.model.trim() || vote.signal.id !== id || !Number.isFinite(vote.weight) || vote.weight <= 0)) throw new Error("ENSEMBLE_VOTE_INVALID");
  const weightTotal = votes.reduce((sum, vote) => sum + vote.weight, 0);
  const score = Math.round(votes.reduce((sum, vote) => sum + vote.signal.scoreBasisPoints * vote.weight, 0) / weightTotal);
  const confidence = Math.round(votes.reduce((sum, vote) => sum + vote.signal.confidenceBasisPoints * vote.weight, 0) / weightTotal);
  const action: StrategyAction = score >= 2_500 && confidence >= 6_000 ? "BUY" : score <= -2_000 || confidence < 3_500 ? "AVOID" : "WATCH";
  return { id, action, scoreBasisPoints: score, confidenceBasisPoints: confidence, votes: [...votes], paperOnly: true, liveExecutionEnabled: false };
}

export type CostedOutcome = { grossProfitCents: bigint; feeCents: bigint; slippageCents: bigint; netProfitCents: bigint; paperOnly: true };
export function applyPaperTradingCosts(entryPriceCents: bigint, exitPriceCents: bigint, config: StrategyConfig): CostedOutcome {
  validateStrategyConfig(config);
  if (entryPriceCents <= 0n || exitPriceCents < 0n) throw new Error("COST_PRICE_INVALID");
  const gross = exitPriceCents - entryPriceCents;
  const turnover = entryPriceCents + exitPriceCents;
  const fee = (turnover * BigInt(config.feeBasisPoints)) / 10_000n;
  const slippage = (turnover * BigInt(config.slippageBasisPoints)) / 10_000n;
  return { grossProfitCents: gross, feeCents: fee, slippageCents: slippage, netProfitCents: gross - fee - slippage, paperOnly: true };
}

export type PositionSizingInput = { capitalCents: bigint; riskBudgetCents: bigint; entryPriceCents: bigint; stopLossBasisPoints: number; maxUnits: bigint };
export type PositionSize = { units: bigint; notionalCents: bigint; riskCents: bigint; capped: boolean; paperOnly: true };
export function calculatePaperPositionSize(input: PositionSizingInput): PositionSize {
  if (input.capitalCents <= 0n || input.riskBudgetCents < 0n || input.entryPriceCents <= 0n || input.maxUnits < 0n) throw new Error("POSITION_INPUT_INVALID");
  if (!Number.isInteger(input.stopLossBasisPoints) || input.stopLossBasisPoints <= 0 || input.stopLossBasisPoints > 10_000) throw new Error("STOP_LOSS_INVALID");
  const riskPerUnit = (input.entryPriceCents * BigInt(input.stopLossBasisPoints)) / 10_000n;
  const byRisk = riskPerUnit === 0n ? 0n : input.riskBudgetCents / riskPerUnit;
  const byCapital = input.capitalCents / input.entryPriceCents;
  const units = [byRisk, byCapital, input.maxUnits].reduce((smallest, value) => value < smallest ? value : smallest, byRisk);
  return { units, notionalCents: units * input.entryPriceCents, riskCents: units * riskPerUnit, capped: units === input.maxUnits || units === byRisk || units === byCapital, paperOnly: true };
}

export type Exposure = { id: string; notionalCents: bigint; category: string };
export type ExposureLimits = { maxTotalCents: bigint; maxCategoryCents: bigint };
export function checkPaperExposure(exposures: readonly Exposure[], limits: ExposureLimits): string[] {
  if (limits.maxTotalCents < 0n || limits.maxCategoryCents < 0n) throw new Error("EXPOSURE_LIMIT_INVALID");
  const reasons: string[] = [];
  const total = exposures.reduce((sum, item) => sum + item.notionalCents, 0n);
  if (exposures.some((item) => item.notionalCents < 0n || !item.category.trim())) throw new Error("EXPOSURE_ITEM_INVALID");
  if (total > limits.maxTotalCents) reasons.push("MAX_TOTAL_EXPOSURE_EXCEEDED");
  const categories = new Map<string, bigint>();
  for (const item of exposures) categories.set(item.category, (categories.get(item.category) ?? 0n) + item.notionalCents);
  for (const [category, amount] of categories) if (amount > limits.maxCategoryCents) reasons.push(`MAX_CATEGORY_EXPOSURE_EXCEEDED:${category}`);
  return reasons;
}

export type WalkForwardSplit<T> = { train: readonly T[]; test: readonly T[] };
export function createWalkForwardSplits<T>(items: readonly T[], trainSize: number, testSize: number, step = testSize): WalkForwardSplit<T>[] {
  if (!Number.isInteger(trainSize) || !Number.isInteger(testSize) || !Number.isInteger(step) || trainSize <= 0 || testSize <= 0 || step <= 0) throw new Error("WALK_FORWARD_WINDOW_INVALID");
  const splits: WalkForwardSplit<T>[] = [];
  for (let start = 0; start + trainSize + testSize <= items.length; start += step) splits.push({ train: items.slice(start, start + trainSize), test: items.slice(start + trainSize, start + trainSize + testSize) });
  if (splits.length === 0) throw new Error("WALK_FORWARD_DATASET_TOO_SMALL");
  return splits;
}

export type BenchmarkResult = { strategyReturnBasisPoints: bigint | null; buyAndHoldReturnBasisPoints: bigint | null; excessReturnBasisPoints: bigint | null; paperOnly: true };
export function compareToBuyAndHold(result: BacktestResult, firstPriceCents: bigint, lastPriceCents: bigint): BenchmarkResult {
  if (firstPriceCents <= 0n || lastPriceCents < 0n) throw new Error("BENCHMARK_PRICE_INVALID");
  const buyHold = ((lastPriceCents - firstPriceCents) * 10_000n) / firstPriceCents;
  const strategy = result.returnBasisPoints;
  return { strategyReturnBasisPoints: strategy, buyAndHoldReturnBasisPoints: buyHold, excessReturnBasisPoints: strategy === null ? null : strategy - buyHold, paperOnly: true };
}

export function fingerprintResearchInput(value: string): string {
  if (!value) throw new Error("RESEARCH_INPUT_EMPTY");
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16_777_619); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type ResearchRun = { configVersion: string; inputFingerprint: string; signals: readonly StrategySignal[]; backtest: BacktestResult; paperOnly: true; liveExecutionEnabled: false };
export function runPaperResearch(observations: readonly StrategyObservation[], bars: readonly BacktestBar[], config: StrategyConfig, initialCapitalCents: bigint): ResearchRun {
  const validated = validateStrategyConfig(config);
  const signals = observations.map((observation) => generateStrategySignal(observation));
  const backtest = runPaperBacktest(bars, initialCapitalCents);
  return { configVersion: validated.version, inputFingerprint: fingerprintResearchInput(JSON.stringify(observations.map((item) => item.id))), signals, backtest, paperOnly: true, liveExecutionEnabled: false };
}
