import { CircuitBreaker } from "./circuit-breaker.js";
import { ProviderHttpClient } from "./http-client.js";
import type { ProviderRuntimeConfig } from "./provider-config.js";
import type {
  ProductSearchRequest,
  ProviderAdapter,
  ProviderHealth,
  ProviderProduct,
} from "./types.js";

interface CatalogProductDto {
  id: string;
  title: string;
  url: string;
  currency: string;
  priceMinor: number;
  observedAt: string;
}

interface CatalogSearchDto {
  items: CatalogProductDto[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCatalogProduct(value: unknown, providerId: string): ProviderProduct {
  if (!isRecord(value)) throw new Error("Catalog product must be an object");
  const { id, title, url, currency, priceMinor, observedAt } = value;
  if (
    typeof id !== "string" || !id.trim() ||
    typeof title !== "string" || !title.trim() ||
    typeof url !== "string" ||
    typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) ||
    typeof priceMinor !== "number" || !Number.isSafeInteger(priceMinor) || priceMinor < 0 ||
    typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))
  ) {
    throw new Error("Catalog product has an invalid field");
  }
  let productUrl: URL;
  try {
    productUrl = new URL(url);
  } catch {
    throw new Error("Catalog product URL is invalid");
  }
  if (productUrl.protocol !== "https:") throw new Error("Catalog product URL must use HTTPS");

  return {
    providerId,
    externalId: id,
    title,
    url: productUrl.toString(),
    currency,
    priceMinor,
    observedAt,
    simulated: false,
  };
}

/**
 * Read-only adapter for providers exposing the documented AutonomAgent Catalog
 * REST contract: GET /health and GET /products?q=&limit=&currency=.
 * This is a generic adapter contract, not an integration with a named marketplace.
 */
export class CatalogRestAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities = ["PRODUCT_SEARCH"] as const;
  readonly simulated = false;
  private readonly client: ProviderHttpClient;
  private readonly breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 15_000 });

  constructor(config: ProviderRuntimeConfig, displayName: string) {
    if (!config.enabled) throw new Error("Cannot construct a disabled provider adapter");
    this.providerId = config.providerId;
    this.displayName = displayName;
    this.client = new ProviderHttpClient(config);
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      await this.breaker.execute(() => this.client.getJson<unknown>("health", {}, signal));
      return {
        status: "HEALTHY",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      return {
        status: this.breaker.getState() === "OPEN" ? "UNAVAILABLE" : "DEGRADED",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        message: "Provider health check failed; details withheld",
      };
    }
  }

  async searchProducts(
    request: ProductSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly ProviderProduct[]> {
    const query = request.query.trim();
    const currency = request.currency.toUpperCase();
    if (!query || query.length > 200) throw new Error("Product query must contain 1-200 characters");
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
      throw new Error("Product search limit must be between 1 and 50");
    }
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter code");

    return this.breaker.execute(async () => {
      const result = await this.client.getJson<unknown>("products", {
        q: query,
        limit: String(request.limit),
        currency,
      }, signal);
      if (!isRecord(result) || !Array.isArray(result.items)) {
        throw new Error("Catalog search response must contain an items array");
      }
      if (result.items.length > request.limit) {
        throw new Error("Catalog search returned more items than requested");
      }
      return (result as unknown as CatalogSearchDto).items.map((item) =>
        parseCatalogProduct(item, this.providerId),
      );
    });
  }
}
