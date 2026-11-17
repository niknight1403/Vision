import { generateStrategySignal, type StrategyObservation } from "./strategy-signals.js";

export type BacktestBar = StrategyObservation & { exitPriceCents: bigint };

export type BacktestTrade = {
  id: string;
  entryPriceCents: bigint;
  exitPriceCents: bigint;
  profitCents: bigint;
  action: "BUY";
};

export type BacktestResult = {
  initialCapitalCents: bigint;
  finalCapitalCents: bigint;
  profitCents: bigint;
  returnBasisPoints: bigint | null;
  maxDrawdownCents: bigint;
  winningTrades: number;
  losingTrades: number;
  trades: readonly BacktestTrade[];
  paperOnly: true;
  liveExecutionEnabled: false;
};

function validateBar(bar: BacktestBar): void {
  if (bar.exitPriceCents <= 0n) throw new Error("BACKTEST_EXIT_PRICE_INVALID");
}

/**
 * Walks bars in supplied order and only uses the current bar to create a signal.
 * It is an evaluation tool, never a broker or execution path.
 */
export function runPaperBacktest(bars: readonly BacktestBar[], initialCapitalCents: bigint): BacktestResult {
  if (initialCapitalCents <= 0n) throw new Error("BACKTEST_INITIAL_CAPITAL_INVALID");
  const ids = new Set<string>();
  let capital = initialCapitalCents;
  let peak = capital;
  let maxDrawdown = 0n;
  const trades: BacktestTrade[] = [];
  for (const bar of bars) {
    validateBar(bar);
    if (ids.has(bar.id)) throw new Error("BACKTEST_DUPLICATE_ID");
    ids.add(bar.id);
    const signal = generateStrategySignal(bar);
    if (signal.action !== "BUY") continue;
    const profit = bar.exitPriceCents - bar.priceCents;
    capital += profit;
    trades.push({ id: bar.id, entryPriceCents: bar.priceCents, exitPriceCents: bar.exitPriceCents, profitCents: profit, action: "BUY" });
    if (capital > peak) peak = capital;
    const drawdown = peak - capital;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  const profit = capital - initialCapitalCents;
  return {
    initialCapitalCents,
    finalCapitalCents: capital,
    profitCents: profit,
    returnBasisPoints: (profit * 10_000n) / initialCapitalCents,
    maxDrawdownCents: maxDrawdown,
    winningTrades: trades.filter((trade) => trade.profitCents > 0n).length,
    losingTrades: trades.filter((trade) => trade.profitCents <= 0n).length,
    trades,
    paperOnly: true,
    liveExecutionEnabled: false,
  };
}
