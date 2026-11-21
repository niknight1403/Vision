export type ProviderCapability =
  | "PRODUCT_SEARCH"
  | "PRICE_LOOKUP"
  | "STOCK_LOOKUP";

export type ProviderHealthStatus =
  | "HEALTHY"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "UNKNOWN";

export interface ProviderHealth {
  status: ProviderHealthStatus;
  checkedAt: string;
  latencyMs?: number;
  message?: string;
}

export interface ProductSearchRequest {
  query: string;
  limit: number;
  currency: string;
}

export interface ProviderProduct {
  providerId: string;
  externalId: string;
  title: string;
  url: string;
  imageUrl?: string;
  currency: string;
  priceMinor: number;
  observedAt: string;
  /** True only when returned by an explicitly simulated adapter. */
  simulated: boolean;
}

export interface PriceLookupRequest {
  externalId: string;
  currency: string;
}

export interface StockLookupRequest {
  externalId: string;
}

export interface ProviderAdapter {
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly simulated: boolean;
  healthCheck(signal?: AbortSignal): Promise<ProviderHealth>;
  searchProducts?(
    request: ProductSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly ProviderProduct[]>;
  getPrice?(
    request: PriceLookupRequest,
    signal?: AbortSignal,
  ): Promise<ProviderProduct>;
  getStock?(
    request: StockLookupRequest,
    signal?: AbortSignal,
  ): Promise<{ available: boolean; observedAt: string; simulated: boolean }>;
}

export class ProviderCapabilityError extends Error {
  constructor(providerId: string, capability: ProviderCapability) {
    super(`Provider "${providerId}" does not support ${capability}`);
    this.name = "ProviderCapabilityError";
  }
}
