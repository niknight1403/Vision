import type {
  ProductSearchRequest,
  ProviderAdapter,
  ProviderHealth,
  ProviderProduct,
} from "./types.js";

const STAGING_PRODUCTS: readonly Omit<ProviderProduct, "providerId" | "observedAt">[] = [
  {
    externalId: "staging-camera-001",
    title: "Staging Kamera 35mm Sammlerobjekt",
    url: "https://staging.catalog.invalid/products/staging-camera-001",
    currency: "EUR",
    priceMinor: 12500,
    simulated: true,
  },
  {
    externalId: "staging-console-002",
    title: "Staging Retro-Konsole mit Zubehör",
    url: "https://staging.catalog.invalid/products/staging-console-002",
    currency: "EUR",
    priceMinor: 8900,
    simulated: true,
  },
  {
    externalId: "staging-lamp-003",
    title: "Staging Design-Schreibtischlampe",
    url: "https://staging.catalog.invalid/products/staging-lamp-003",
    currency: "EUR",
    priceMinor: 4700,
    simulated: true,
  },
];

function validateRequest(request: ProductSearchRequest): void {
  if (!request.query.trim() || request.query.length > 200) {
    throw new Error("Product search query must contain 1-200 characters");
  }
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
    throw new Error("Product search limit must be between 1 and 50");
  }
  if (request.currency.toUpperCase() !== "EUR") {
    throw new Error("Staging catalog supports EUR only");
  }
}

/**
 * In-memory provider used only to verify the autonomous staging pipeline.
 * It is intentionally synthetic and has no mutating capability or network path.
 */
export class StagingCatalogAdapter implements ProviderAdapter {
  readonly providerId = "catalog-staging";
  readonly displayName = "Synthetic staging catalog";
  readonly capabilities = ["PRODUCT_SEARCH"] as const;
  readonly simulated = true as const;

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    if (signal?.aborted) throw signal.reason ?? new Error("Provider health check aborted");
    return {
      status: "HEALTHY",
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      message: "Synthetic staging data only; no live provider contacted",
    };
  }

  async searchProducts(
    request: ProductSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly ProviderProduct[]> {
    validateRequest(request);
    if (signal?.aborted) throw signal.reason ?? new Error("Product search aborted");
    const query = request.query.trim().toLocaleLowerCase("de-DE");
    const observedAt = new Date().toISOString();
    return STAGING_PRODUCTS
      .filter((product) => `${product.externalId} ${product.title}`.toLocaleLowerCase("de-DE").includes(query))
      .slice(0, request.limit)
      .map((product) => ({ ...product, providerId: this.providerId, observedAt }));
  }
}
