import { describe, expect, it } from "vitest";
import { analyzeDeals, type DealProduct } from "./deal-scanner.js";

const product: DealProduct = {
  providerId: "catalog-demo",
  externalId: "sku-42",
  title: "Camera",
  url: "https://catalog.example/products/sku-42",
  currency: "EUR",
  priceMinor: 10_000,
  observedAt: "2026-11-17T00:00:00.000Z",
  simulated: false,
};

const costs = {
  inboundShippingCents: 500n,
  outboundShippingCents: 500n,
  marketplaceFeeCents: 1_000n,
  paymentFeeCents: 200n,
  packagingCents: 100n,
  riskReserveCents: 200n,
};

const context = {
  resalePriceCents: 15_000n,
  openTrades: 0,
  dailyLossCents: 0n,
  riskLimits: {
    maxTradeCents: 20_000n,
    maxOpenTrades: 3,
    maxDailyLossCents: 5_000n,
    minProfitCents: 1_000n,
    minRoiBasisPoints: 1_000n,
  },
};

describe("analyzeDeals", () => {
  it("calculates net margin and evaluates risk using integer cents", () => {
    const [deal] = analyzeDeals([product], costs, context);
    expect(deal.totalCostCents).toBe(12_500n);
    expect(deal.expectedProfitCents).toBe(2_500n);
    expect(deal.roiBasisPoints).toBe(2_000n);
    expect(deal.approvedByRiskRules).toBe(true);
    expect(deal.riskReasons).toEqual([]);
  });

  it("marks deals that fail minimum profit as rejected", () => {
    const [deal] = analyzeDeals([product], costs, {
      ...context,
      resalePriceCents: 12_000n,
    });
    expect(deal.approvedByRiskRules).toBe(false);
    expect(deal.riskReasons).toContain("MIN_PROFIT_NOT_MET");
  });

  it("rejects non-EUR until currency conversion exists", () => {
    expect(() => analyzeDeals([{ ...product, currency: "USD" }], costs, context))
      .toThrow(/currency conversion/);
  });

  it("rejects unsafe provider price values and duplicate identities", () => {
    expect(() => analyzeDeals([{ ...product, priceMinor: -1 }], costs, context))
      .toThrow(/safe integer/);
    expect(() => analyzeDeals([product, product], costs, context))
      .toThrow(/duplicate/);
  });
});

describe("scanProviderDeals", () => {
  it("passes the bounded search request into the provider and analyzes only returned products", async () => {
    const searchProducts = async (request: { query: string; limit: number; currency: string }) => {
      expect(request).toEqual({ query: "camera", limit: 5, currency: "EUR" });
      return [product];
    };
    const result = await (await import("./deal-scanner.js")).scanProviderDeals({
      providerId: "catalog-demo",
      capabilities: ["PRODUCT_SEARCH"],
      searchProducts,
    }, {
      query: " camera ",
      limit: 5,
      currency: "EUR",
      costs,
      context,
    });
    expect(result).toHaveLength(1);
    expect(result[0].externalId).toBe("sku-42");
  });

  it("fails closed when search capability is missing or provider returns no products", async () => {
    const request = { query: "camera", limit: 5, currency: "EUR", costs, context };
    await expect((await import("./deal-scanner.js")).scanProviderDeals({
      providerId: "no-search",
      capabilities: [],
    }, request)).rejects.toThrow(/PRODUCT_SEARCH/);

    const empty = await (await import("./deal-scanner.js")).scanProviderDeals({
      providerId: "empty",
      capabilities: ["PRODUCT_SEARCH"],
      searchProducts: async () => [],
    }, request);
    expect(empty).toEqual([]);
  });

  it("rejects oversized provider results and invalid request limits", async () => {
    const provider = {
      providerId: "catalog-demo",
      capabilities: ["PRODUCT_SEARCH"],
      searchProducts: async () => [product, { ...product, externalId: "sku-43" }],
    };
    await expect((await import("./deal-scanner.js")).scanProviderDeals(provider, {
      query: "camera", limit: 1, currency: "EUR", costs, context,
    })).rejects.toThrow(/more products/);
    await expect((await import("./deal-scanner.js")).scanProviderDeals(provider, {
      query: "camera", limit: 51, currency: "EUR", costs, context,
    })).rejects.toThrow(/limit/);
  });
});

