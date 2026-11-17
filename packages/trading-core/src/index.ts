export type ProfitInput = {
  buyPriceCents: bigint;
  inboundShippingCents: bigint;
  outboundShippingCents: bigint;
  marketplaceFeeCents: bigint;
  paymentFeeCents: bigint;
  packagingCents: bigint;
  riskReserveCents: bigint;
  resalePriceCents: bigint;
};

export type ProfitResult = {
  totalCostCents: bigint;
  netProfitCents: bigint;
  roiBasisPoints: bigint | null;
};

export function calculateNetProfit(input: ProfitInput): ProfitResult {
  const values = Object.values(input);
  if (values.some((value) => value < 0n)) throw new Error("Amounts must be non-negative");
  const totalCostCents =
    input.buyPriceCents +
    input.inboundShippingCents +
    input.outboundShippingCents +
    input.marketplaceFeeCents +
    input.paymentFeeCents +
    input.packagingCents +
    input.riskReserveCents;
  const netProfitCents = input.resalePriceCents - totalCostCents;
  const roiBasisPoints =
    totalCostCents === 0n ? null : (netProfitCents * 10_000n) / totalCostCents;
  return { totalCostCents, netProfitCents, roiBasisPoints };
}

export type RiskLimits = {
  maxTradeCents: bigint;
  maxOpenTrades: number;
  maxDailyLossCents: bigint;
  minProfitCents: bigint;
  minRoiBasisPoints: bigint;
};

export type RiskCandidate = {
  totalCostCents: bigint;
  expectedProfitCents: bigint;
  roiBasisPoints: bigint | null;
  openTrades: number;
  dailyLossCents: bigint;
};

export function evaluateRisk(candidate: RiskCandidate, limits: RiskLimits): string[] {
  const reasons: string[] = [];
  if (candidate.totalCostCents <= 0n) reasons.push("INVALID_TOTAL_COST");
  if (candidate.totalCostCents > limits.maxTradeCents) reasons.push("MAX_TRADE_EXCEEDED");
  if (candidate.openTrades >= limits.maxOpenTrades) reasons.push("MAX_OPEN_TRADES_REACHED");
  if (candidate.dailyLossCents >= limits.maxDailyLossCents) reasons.push("DAILY_LOSS_LIMIT_REACHED");
  if (candidate.expectedProfitCents < limits.minProfitCents) reasons.push("MIN_PROFIT_NOT_MET");
  if (candidate.roiBasisPoints === null || candidate.roiBasisPoints < limits.minRoiBasisPoints) reasons.push("MIN_ROI_NOT_MET");
  return reasons;
}

export * from "./autopilot.js";

export * from "./deal-scanner.js";

export * from "./strategy-signals.js";

export * from "./strategy-allocation.js";

export * from "./strategy-backtest.js";

export * from "./research-pipeline.js";

export * from "./backtest-optimization.js";

export * from "./live-paper-simulation.js";
