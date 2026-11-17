export type StrategyAction = "BUY" | "WATCH" | "AVOID";

export type StrategyObservation = {
  id: string;
  observedAt: string;
  priceCents: bigint;
  fairValueCents: bigint;
  demandScore: number;
  inventoryScore: number;
  volatilityScore: number;
};

export type StrategySignal = {
  id: string;
  observedAt: string;
  action: StrategyAction;
  scoreBasisPoints: number;
  confidenceBasisPoints: number;
  factors: readonly string[];
  paperOnly: true;
  liveExecutionEnabled: false;
};

function scorePart(value: number, name: string): { value: number; factor: string } {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a number between 0 and 100`);
  }
  return { value, factor: `${name}:${Math.round(value)}` };
}

function validateObservation(observation: StrategyObservation): void {
  if (!observation.id.trim()) throw new Error("STRATEGY_ID_REQUIRED");
  if (!Number.isFinite(Date.parse(observation.observedAt))) throw new Error("STRATEGY_TIMESTAMP_INVALID");
  if (observation.priceCents <= 0n || observation.fairValueCents <= 0n) {
    throw new Error("STRATEGY_PRICES_MUST_BE_POSITIVE");
  }
}

/**
 * Produces a transparent, deterministic signal from bounded features.
 * The name AI refers to a strategy feature pipeline, not an autonomous model
 * or execution agent. No network, order, or broker operation is performed.
 */
export function generateStrategySignal(observation: StrategyObservation): StrategySignal {
  validateObservation(observation);
  const demand = scorePart(observation.demandScore, "demandScore");
  const inventory = scorePart(observation.inventoryScore, "inventoryScore");
  const volatility = scorePart(observation.volatilityScore, "volatilityScore");
  const valueGap = Number(((observation.fairValueCents - observation.priceCents) * 10_000n) / observation.priceCents);
  const boundedValueGap = Math.max(-100, Math.min(100, valueGap / 100));
  const score = Math.round(boundedValueGap * 0.45 + (demand.value - 50) * 0.3 + (50 - inventory.value) * 0.15 + (50 - volatility.value) * 0.1);
  const confidence = Math.max(0, Math.min(10_000, Math.round(5_000 + Math.abs(score) * 45 - volatility.value * 20)));
  const action: StrategyAction = score >= 25 && confidence >= 6_000 ? "BUY" : score <= -20 || confidence < 3_500 ? "AVOID" : "WATCH";
  const factors = [
    `VALUE_GAP_BPS:${valueGap}`,
    demand.factor,
    inventory.factor,
    volatility.factor,
    `CONFIDENCE_BPS:${confidence}`,
  ];
  return { id: observation.id, observedAt: observation.observedAt, action, scoreBasisPoints: score * 100, confidenceBasisPoints: confidence, factors, paperOnly: true, liveExecutionEnabled: false };
}

export function generateStrategySignals(observations: readonly StrategyObservation[]): StrategySignal[] {
  const seen = new Set<string>();
  return observations.map((observation) => {
    if (seen.has(observation.id)) throw new Error("STRATEGY_DUPLICATE_ID");
    seen.add(observation.id);
    return generateStrategySignal(observation);
  });
}
