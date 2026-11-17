import { calculateNetProfit, evaluateRisk, type ProfitInput, type RiskLimits } from "./index.js";

export interface DealProduct {
  providerId: string;
  externalId: string;
  title: string;
  url: string;
  currency: string;
  priceMinor: number;
  observedAt: string;
  simulated: boolean;
}

export interface DealCostProfile {
  inboundShippingCents: bigint;
  outboundShippingCents: bigint;
  marketplaceFeeCents: bigint;
  paymentFeeCents: bigint;
  packagingCents: bigint;
  riskReserveCents: bigint;
}

export interface DealScanContext {
  resalePriceCents: bigint;
  openTrades: number;
  dailyLossCents: bigint;
  riskLimits: RiskLimits;
}

export interface DealAnalysis {
  providerId: string;
  externalId: string;
  title: string;
  url: string;
  currency: string;
  purchasePriceMinor: number;
  observedAt: string;
  simulated: boolean;
  totalCostCents: bigint;
  expectedProfitCents: bigint;
  roiBasisPoints: bigint | null;
  approvedByRiskRules: boolean;
  riskReasons: string[];
}

function toCents(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Provider price must be a non-negative safe integer in minor units");
  }
  return BigInt(value);
}

function validateNonNegative(name: string, value: bigint): void {
  if (value < 0n) throw new Error(`${name} must be non-negative`);
}

/**
 * Converts read-only provider results into transparent deal candidates.
 * This function never reserves funds, places orders, or claims realized profit.
 */
export function analyzeDeals(
  products: readonly DealProduct[],
  costs: DealCostProfile,
  context: DealScanContext,
): DealAnalysis[] {
  for (const [name, value] of Object.entries(costs)) {
    validateNonNegative(name, value);
  }
  validateNonNegative("resalePriceCents", context.resalePriceCents);
  validateNonNegative("dailyLossCents", context.dailyLossCents);
  if (!Number.isInteger(context.openTrades) || context.openTrades < 0) {
    throw new Error("openTrades must be a non-negative integer");
  }

  const seen = new Set<string>();
  return products.map((product) => {
    if (product.currency !== "EUR") {
      throw new Error("Deal scan currently requires EUR prices; currency conversion is not implemented");
    }
    const identity = `${product.providerId}:${product.externalId}`;
    if (seen.has(identity)) throw new Error("Provider returned duplicate product identity");
    seen.add(identity);

    const profitInput: ProfitInput = {
      buyPriceCents: toCents(product.priceMinor),
      ...costs,
      resalePriceCents: context.resalePriceCents,
    };
    const profit = calculateNetProfit(profitInput);
    const reasons = evaluateRisk({
      totalCostCents: profit.totalCostCents,
      expectedProfitCents: profit.netProfitCents,
      roiBasisPoints: profit.roiBasisPoints,
      openTrades: context.openTrades,
      dailyLossCents: context.dailyLossCents,
    }, context.riskLimits);

    return {
      providerId: product.providerId,
      externalId: product.externalId,
      title: product.title,
      url: product.url,
      currency: product.currency,
      purchasePriceMinor: product.priceMinor,
      observedAt: product.observedAt,
      simulated: product.simulated,
      totalCostCents: profit.totalCostCents,
      expectedProfitCents: profit.netProfitCents,
      roiBasisPoints: profit.roiBasisPoints,
      approvedByRiskRules: reasons.length === 0,
      riskReasons: reasons,
    };
  });
}

export interface DealSearchProvider {
  readonly providerId: string;
  readonly capabilities: readonly string[];
  searchProducts?: (request: {
    query: string;
    limit: number;
    currency: string;
  }, signal?: AbortSignal) => Promise<readonly DealProduct[]>;
}

export interface ProviderDealScanRequest {
  query: string;
  limit: number;
  currency: string;
  costs: DealCostProfile;
  context: DealScanContext;
}

/**
 * Runs the read-only provider search and then analyzes exactly those returned
 * records. No fallback/demo products are fabricated when the provider is absent
 * or fails. Purchase and listing operations are intentionally not part of this API.
 */
export async function scanProviderDeals(
  provider: DealSearchProvider,
  request: ProviderDealScanRequest,
  signal?: AbortSignal,
): Promise<DealAnalysis[]> {
  if (!provider.capabilities.includes("PRODUCT_SEARCH") || typeof provider.searchProducts !== "function") {
    throw new Error(`Provider "${provider.providerId}" does not support PRODUCT_SEARCH`);
  }
  const query = request.query.trim();
  if (!query || query.length > 200) throw new Error("Product query must contain 1-200 characters");
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
    throw new Error("Product search limit must be between 1 and 50");
  }
  if (request.currency !== "EUR") {
    throw new Error("Deal scan currently requires EUR; currency conversion is not implemented");
  }
  if (signal?.aborted) throw signal.reason ?? new Error("Deal scan aborted");

  const products = await provider.searchProducts({
    query,
    limit: request.limit,
    currency: request.currency,
  }, signal);
  if (signal?.aborted) throw signal.reason ?? new Error("Deal scan aborted");
  if (products.length > request.limit) {
    throw new Error("Provider returned more products than requested");
  }
  return analyzeDeals(products, request.costs, request.context);
}

