import { generateStrategySignal, type StrategyObservation } from "./strategy-signals.js";
import { applyPaperTradingCosts, fingerprintResearchInput, type StrategyConfig } from "./research-pipeline.js";

export type PaperTick = StrategyObservation & {
  sequence: number;
  receivedAt: string;
  bidCents: bigint;
  askCents: bigint;
  liquidityCents: bigint;
};

export type PaperSimulationConfig = StrategyConfig & {
  initialCapitalCents: bigint;
  orderNotionalCents: bigint;
  maxLatencyMs: number;
  fillRatioBasisPoints: number;
  maxDrawdownBasisPoints: number;
  minCashReserveCents: bigint;
};

export type PaperOrderStatus = "SUBMITTED" | "FILLED" | "REJECTED" | "CANCELLED";
export type PaperOrder = {
  id: string;
  tickId: string;
  submittedAt: string;
  fillAt: string | null;
  side: "BUY" | "SELL";
  requestedNotionalCents: bigint;
  filledNotionalCents: bigint;
  fillPriceCents: bigint | null;
  latencyMs: number;
  status: PaperOrderStatus;
  reason: string | null;
};

export type PaperEquityPoint = { sequence: number; timestamp: string; cashCents: bigint; positionValueCents: bigint; equityCents: bigint; drawdownCents: bigint; drawdownBasisPoints: bigint };
export type PaperAlert = { sequence: number; severity: "INFO" | "WARNING" | "CRITICAL"; code: string; message: string };
export type LivePaperSession = {
  sessionId: string;
  inputFingerprint: string;
  initialCapitalCents: bigint;
  finalCashCents: bigint;
  finalEquityCents: bigint;
  realizedProfitCents: bigint;
  returnBasisPoints: bigint;
  maxDrawdownCents: bigint;
  maxDrawdownBasisPoints: bigint;
  orders: readonly PaperOrder[];
  equityCurve: readonly PaperEquityPoint[];
  alerts: readonly PaperAlert[];
  ticksProcessed: number;
  paperOnly: true;
  liveExecutionEnabled: false;
};

function validateConfig(config: PaperSimulationConfig): void {
  if (config.initialCapitalCents <= 0n || config.orderNotionalCents <= 0n || config.minCashReserveCents < 0n) throw new Error("PAPER_SESSION_CAPITAL_INVALID");
  if (!Number.isInteger(config.maxLatencyMs) || config.maxLatencyMs < 0 || config.maxLatencyMs > 86_400_000) throw new Error("PAPER_LATENCY_INVALID");
  if (!Number.isInteger(config.fillRatioBasisPoints) || config.fillRatioBasisPoints <= 0 || config.fillRatioBasisPoints > 10_000) throw new Error("PAPER_FILL_RATIO_INVALID");
  if (!Number.isInteger(config.maxDrawdownBasisPoints) || config.maxDrawdownBasisPoints < 0 || config.maxDrawdownBasisPoints > 10_000) throw new Error("PAPER_DRAWDOWN_LIMIT_INVALID");
}

export function validatePaperTicks(ticks: readonly PaperTick[]): void {
  let previousSequence = -1;
  let previousTime = -Infinity;
  const ids = new Set<string>();
  for (const tick of ticks) {
    const time = Date.parse(tick.receivedAt);
    if (!tick.id.trim() || !Number.isFinite(time)) throw new Error("PAPER_TICK_INVALID");
    if (ids.has(tick.id)) throw new Error("PAPER_TICK_DUPLICATE");
    if (!Number.isInteger(tick.sequence) || tick.sequence <= previousSequence || time < previousTime) throw new Error("PAPER_TICK_ORDER_INVALID");
    if (tick.bidCents <= 0n || tick.askCents < tick.bidCents || tick.liquidityCents < 0n) throw new Error("PAPER_QUOTE_INVALID");
    ids.add(tick.id);
    previousSequence = tick.sequence;
    previousTime = time;
  }
}

function latencyBetween(submittedAt: string, receivedAt: string, maxLatencyMs: number): number {
  const elapsed = Date.parse(receivedAt) - Date.parse(submittedAt);
  return Math.max(0, Math.min(maxLatencyMs, elapsed));
}

export function simulateLivePaperSession(sessionId: string, ticks: readonly PaperTick[], config: PaperSimulationConfig): LivePaperSession {
  if (!sessionId.trim()) throw new Error("PAPER_SESSION_ID_REQUIRED");
  validateConfig(config);
  validatePaperTicks(ticks);
  let cash = config.initialCapitalCents;
  let peak = cash;
  let maxDrawdown = 0n;
  let positionUnits = 0n;
  let averageEntryCents = 0n;
  let realizedProfit = 0n;
  const orders: PaperOrder[] = [];
  const equityCurve: PaperEquityPoint[] = [];
  const alerts: PaperAlert[] = [];
  for (const tick of ticks) {
    const signal = generateStrategySignal(tick);
    if (signal.action === "BUY" && positionUnits === 0n) {
      const available = cash - config.minCashReserveCents;
      const requested = available < config.orderNotionalCents ? 0n : config.orderNotionalCents;
      const orderId = `${sessionId}:${tick.sequence}:BUY`;
      if (requested === 0n) {
        orders.push({ id: orderId, tickId: tick.id, submittedAt: tick.receivedAt, fillAt: null, side: "BUY", requestedNotionalCents: config.orderNotionalCents, filledNotionalCents: 0n, fillPriceCents: null, latencyMs: 0, status: "REJECTED", reason: "CASH_RESERVE_LIMIT" });
        alerts.push({ sequence: tick.sequence, severity: "WARNING", code: "ORDER_REJECTED_CASH_RESERVE", message: "Virtuelle Order wegen Cash-Reserve abgelehnt" });
      } else {
        const fillNotional = (requested * BigInt(config.fillRatioBasisPoints)) / 10_000n;
        const fillPrice = tick.askCents;
        const units = fillPrice === 0n ? 0n : fillNotional / fillPrice;
        const latency = latencyBetween(tick.receivedAt, tick.receivedAt, config.maxLatencyMs);
        if (units === 0n) {
          orders.push({ id: orderId, tickId: tick.id, submittedAt: tick.receivedAt, fillAt: null, side: "BUY", requestedNotionalCents: requested, filledNotionalCents: 0n, fillPriceCents: null, latencyMs: latency, status: "REJECTED", reason: "FILL_TOO_SMALL" });
        } else {
          const actualNotional = units * fillPrice;
          cash -= actualNotional;
          positionUnits = units;
          averageEntryCents = fillPrice;
          orders.push({ id: orderId, tickId: tick.id, submittedAt: tick.receivedAt, fillAt: tick.receivedAt, side: "BUY", requestedNotionalCents: requested, filledNotionalCents: actualNotional, fillPriceCents: fillPrice, latencyMs: latency, status: "FILLED", reason: null });
        }
      }
    } else if (signal.action === "AVOID" && positionUnits > 0n) {
      const proceeds = positionUnits * tick.bidCents;
      const outcome = applyPaperTradingCosts(averageEntryCents, tick.bidCents, config);
      cash += proceeds - outcome.feeCents - outcome.slippageCents;
      realizedProfit += outcome.netProfitCents * positionUnits;
      orders.push({ id: `${sessionId}:${tick.sequence}:SELL`, tickId: tick.id, submittedAt: tick.receivedAt, fillAt: tick.receivedAt, side: "SELL", requestedNotionalCents: proceeds, filledNotionalCents: proceeds, fillPriceCents: tick.bidCents, latencyMs: 0, status: "FILLED", reason: "SIGNAL_AVOID" });
      positionUnits = 0n;
      averageEntryCents = 0n;
    }
    const positionValue = positionUnits * tick.bidCents;
    const equity = cash + positionValue;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    const drawdownBps = peak === 0n ? 0n : (drawdown * 10_000n) / peak;
    if (drawdownBps > BigInt(config.maxDrawdownBasisPoints)) alerts.push({ sequence: tick.sequence, severity: "CRITICAL", code: "MAX_DRAWDOWN_EXCEEDED", message: "Simulierte Equity überschreitet das konfigurierte Drawdown-Limit" });
    equityCurve.push({ sequence: tick.sequence, timestamp: tick.receivedAt, cashCents: cash, positionValueCents: positionValue, equityCents: equity, drawdownCents: drawdown, drawdownBasisPoints: drawdownBps });
  }
  const finalEquity = equityCurve.at(-1)?.equityCents ?? cash;
  return { sessionId, inputFingerprint: fingerprintResearchInput(JSON.stringify(ticks.map((tick) => `${tick.sequence}:${tick.id}`))), initialCapitalCents: config.initialCapitalCents, finalCashCents: cash, finalEquityCents: finalEquity, realizedProfitCents: realizedProfit, returnBasisPoints: ((finalEquity - config.initialCapitalCents) * 10_000n) / config.initialCapitalCents, maxDrawdownCents: maxDrawdown, maxDrawdownBasisPoints: peak === 0n ? 0n : (maxDrawdown * 10_000n) / peak, orders, equityCurve, alerts, ticksProcessed: ticks.length, paperOnly: true, liveExecutionEnabled: false };
}

export type SessionBenchmark = { sessionReturnBasisPoints: bigint; marketReturnBasisPoints: bigint; excessReturnBasisPoints: bigint; paperOnly: true };
export function compareSessionToMarket(session: LivePaperSession, firstMidCents: bigint, lastMidCents: bigint): SessionBenchmark {
  if (firstMidCents <= 0n || lastMidCents < 0n) throw new Error("SESSION_BENCHMARK_INVALID");
  const market = ((lastMidCents - firstMidCents) * 10_000n) / firstMidCents;
  return { sessionReturnBasisPoints: session.returnBasisPoints, marketReturnBasisPoints: market, excessReturnBasisPoints: session.returnBasisPoints - market, paperOnly: true };
}

export type SessionCheckpoint = { sessionId: string; sequence: number; equityCents: bigint; cashCents: bigint; openOrderCount: number; fingerprint: string; paperOnly: true };
export function createSessionCheckpoint(session: LivePaperSession, sequence: number): SessionCheckpoint {
  const point = session.equityCurve.find((item) => item.sequence === sequence);
  if (!point) throw new Error("SESSION_CHECKPOINT_NOT_FOUND");
  return { sessionId: session.sessionId, sequence, equityCents: point.equityCents, cashCents: point.cashCents, openOrderCount: session.orders.filter((order) => order.status === "SUBMITTED").length, fingerprint: fingerprintResearchInput(`${session.inputFingerprint}:${sequence}:${point.equityCents}`), paperOnly: true };
}
