import type { StrategySignal } from "./strategy-signals.js";

export type AllocationCandidate = {
  signal: StrategySignal;
  unitCostCents: bigint;
  expectedProfitCents: bigint;
  riskCents: bigint;
};

export type AllocationLimits = {
  availableCapitalCents: bigint;
  maxPositionCents: bigint;
  maxPortfolioRiskCents: bigint;
  maxPositions: number;
};

export type Allocation = {
  id: string;
  units: bigint;
  capitalCents: bigint;
  expectedProfitCents: bigint;
  riskCents: bigint;
  rationale: string;
};

export type AllocationPlan = {
  allocations: readonly Allocation[];
  unallocatedCapitalCents: bigint;
  totalExpectedProfitCents: bigint;
  totalRiskCents: bigint;
  paperOnly: true;
  executionEnabled: false;
};

function validateLimits(limits: AllocationLimits): void {
  if ([limits.availableCapitalCents, limits.maxPositionCents, limits.maxPortfolioRiskCents].some((value) => value < 0n)) throw new Error("ALLOCATION_LIMITS_MUST_BE_NON_NEGATIVE");
  if (!Number.isInteger(limits.maxPositions) || limits.maxPositions < 0) throw new Error("MAX_POSITIONS_INVALID");
}

/** Greedy ranking is deliberate: it is deterministic and auditable, not an order executor. */
export function allocatePaperCapital(candidates: readonly AllocationCandidate[], limits: AllocationLimits): AllocationPlan {
  validateLimits(limits);
  const seen = new Set<string>();
  const eligible = candidates.filter((candidate) => {
    if (seen.has(candidate.signal.id)) throw new Error("ALLOCATION_DUPLICATE_ID");
    seen.add(candidate.signal.id);
    if (candidate.signal.action !== "BUY") return false;
    if (candidate.unitCostCents <= 0n || candidate.expectedProfitCents <= 0n || candidate.riskCents < 0n) throw new Error("ALLOCATION_CANDIDATE_INVALID");
    return true;
  }).sort((left, right) => right.signal.scoreBasisPoints - left.signal.scoreBasisPoints || left.signal.id.localeCompare(right.signal.id));

  let capital = limits.availableCapitalCents;
  let risk = 0n;
  const allocations: Allocation[] = [];
  for (const candidate of eligible) {
    if (allocations.length >= limits.maxPositions || capital < candidate.unitCostCents || risk + candidate.riskCents > limits.maxPortfolioRiskCents) continue;
    const positionCap = limits.maxPositionCents < candidate.unitCostCents ? 0n : limits.maxPositionCents / candidate.unitCostCents;
    const units = positionCap < 1n ? 0n : positionCap < capital / candidate.unitCostCents ? positionCap : capital / candidate.unitCostCents;
    if (units < 1n) continue;
    const capitalCents = units * candidate.unitCostCents;
    const expectedProfitCents = units * candidate.expectedProfitCents;
    const riskCents = units * candidate.riskCents;
    if (risk + riskCents > limits.maxPortfolioRiskCents) continue;
    allocations.push({ id: candidate.signal.id, units, capitalCents, expectedProfitCents, riskCents, rationale: `PAPER-Ranking ${candidate.signal.scoreBasisPoints} BPS; keine Order ausgeführt` });
    capital -= capitalCents;
    risk += riskCents;
  }
  return { allocations, unallocatedCapitalCents: capital, totalExpectedProfitCents: allocations.reduce((sum, item) => sum + item.expectedProfitCents, 0n), totalRiskCents: risk, paperOnly: true, executionEnabled: false };
}
