import { describe, expect, it } from "vitest";
import { evaluateRisk, calculateNetProfit } from "./index.js";

describe("trading core invariants", () => {
  it("calculates net profit using integer cents", () => {
    const result = calculateNetProfit({
      buyPriceCents: 5000n,
      inboundShippingCents: 300n,
      outboundShippingCents: 500n,
      marketplaceFeeCents: 700n,
      paymentFeeCents: 100n,
      packagingCents: 100n,
      riskReserveCents: 100n,
      resalePriceCents: 8000n,
    });
    expect(result.totalCostCents).toBe(6800n);
    expect(result.netProfitCents).toBe(1200n);
    expect(result.roiBasisPoints).toBe(1764n);
  });

  it("rejects candidates that exceed configured risk limits", () => {
    const reasons = evaluateRisk({
      totalCostCents: 12000n,
      expectedProfitCents: 500n,
      roiBasisPoints: 416n,
      openTrades: 3,
      dailyLossCents: 0n,
    }, {
      maxTradeCents: 10000n,
      maxOpenTrades: 3,
      maxDailyLossCents: 5000n,
      minProfitCents: 1000n,
      minRoiBasisPoints: 1000n,
    });
    expect(reasons).toEqual([
      "MAX_TRADE_EXCEEDED",
      "MAX_OPEN_TRADES_REACHED",
      "MIN_PROFIT_NOT_MET",
      "MIN_ROI_NOT_MET",
    ]);
  });
});
