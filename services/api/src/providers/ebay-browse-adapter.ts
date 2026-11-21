import type {
  ProductSearchRequest,
  ProviderAdapter,
  ProviderHealth,
  ProviderProduct,
} from "./types.js";

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
const REQUEST_TIMEOUT_MS = 8_000;
const PROVIDER_ID = "ebay";

export interface EbayBrowseConfig {
  clientId: string;
  clientSecret: string;
  marketplaceId?: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parsePriceMinor(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : undefined;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Read-only eBay Browse API adapter for public fixed-price listings. */
export class EbayBrowseAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly displayName = "eBay-Angebote";
  readonly capabilities = ["PRODUCT_SEARCH"] as const;
  readonly simulated = false;
  private readonly marketplaceId: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private token: CachedToken | undefined;
  private tokenRequest: Promise<string> | undefined;

  constructor(config: EbayBrowseConfig) {
    if (!config.clientId.trim() || !config.clientSecret.trim()) {
      throw new Error("EBAY_PROVIDER_NOT_CONFIGURED");
    }
    const marketplaceId = config.marketplaceId?.trim().toUpperCase() || "EBAY_DE";
    if (!/^EBAY_[A-Z]{2}$/.test(marketplaceId)) {
      throw new Error("EBAY_MARKETPLACE_ID_INVALID");
    }
    this.clientId = config.clientId.trim();
    this.clientSecret = config.clientSecret.trim();
    this.marketplaceId = marketplaceId;
    this.fetcher = config.fetcher ?? globalThis.fetch;
    this.now = config.now ?? Date.now;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startedAt = this.now();
    try {
      await this.getAccessToken();
      return {
        status: "HEALTHY",
        checkedAt: new Date(this.now()).toISOString(),
        latencyMs: Math.max(0, this.now() - startedAt),
      };
    } catch {
      return {
        status: "UNAVAILABLE",
        checkedAt: new Date(this.now()).toISOString(),
        latencyMs: Math.max(0, this.now() - startedAt),
        message: "eBay Browse API is unavailable or not configured",
      };
    }
  }

  async searchProducts(
    request: ProductSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly ProviderProduct[]> {
    const query = request.query.trim();
    if (!query || query.length > 200) {
      throw new Error("Product query must contain 1-200 characters");
    }
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
      throw new Error("Product search limit must be between 1 and 50");
    }
    if (request.currency.toUpperCase() !== "EUR") {
      throw new Error("eBay Browse search currently supports EUR listings only");
    }

    const accessToken = await this.getAccessToken();
    const url = new URL(SEARCH_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(request.limit));
    url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE}");

    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "x-ebay-c-marketplace-id": this.marketplaceId,
          accept: "application/json",
        },
        signal: requestSignal(signal),
      });
    } catch {
      throw new Error("EBAY_API_UNAVAILABLE");
    }
    if (response.status === 429) throw new Error("EBAY_RATE_LIMITED");
    if (!response.ok) throw new Error("EBAY_SEARCH_FAILED");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("EBAY_RESPONSE_INVALID");
    }
    if (!isRecord(payload)) throw new Error("EBAY_RESPONSE_INVALID");
    const summaries = payload.itemSummaries;
    if (summaries !== undefined && !Array.isArray(summaries)) {
      throw new Error("EBAY_RESPONSE_INVALID");
    }
    const items = (summaries ?? []) as unknown[];
    if (items.length > request.limit) throw new Error("EBAY_RESPONSE_INVALID");

    const observedAt = new Date(this.now()).toISOString();
    return items.flatMap((item): ProviderProduct[] => {
      if (!isRecord(item) || !isRecord(item.price)) return [];
      const { itemId, title, price } = item;
      if (
        typeof itemId !== "string" || !itemId.trim() ||
        typeof title !== "string" || !title.trim() ||
        price.currency !== "EUR"
      ) return [];
      const priceMinor = parsePriceMinor(price.value);
      const productUrl = parseHttpsUrl(item.itemWebUrl);
      if (priceMinor === undefined || !productUrl) return [];
      const imageUrl = isRecord(item.image) ? parseHttpsUrl(item.image.imageUrl) : undefined;
      return [{
        providerId: this.providerId,
        externalId: itemId,
        title: title.trim(),
        url: productUrl,
        ...(imageUrl ? { imageUrl } : {}),
        currency: "EUR",
        priceMinor,
        observedAt,
        simulated: false,
      }];
    });
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - this.now() > 60_000) return this.token.value;
    if (this.tokenRequest) return await this.tokenRequest;
    const request = this.requestAccessToken();
    this.tokenRequest = request;
    try {
      return await request;
    } finally {
      if (this.tokenRequest === request) this.tokenRequest = undefined;
    }
  }

  private async requestAccessToken(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(TOKEN_URL, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: OAUTH_SCOPE }),
        signal: requestSignal(),
      });
    } catch {
      throw new Error("EBAY_OAUTH_FAILED");
    }
    if (!response.ok) throw new Error("EBAY_OAUTH_FAILED");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("EBAY_OAUTH_FAILED");
    }
    if (!isRecord(payload) || typeof payload.access_token !== "string" ||
        typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) ||
        payload.expires_in <= 0) {
      throw new Error("EBAY_OAUTH_FAILED");
    }
    this.token = {
      value: payload.access_token,
      expiresAt: this.now() + payload.expires_in * 1_000,
    };
    return this.token.value;
  }

  private readonly clientId: string;
  private readonly clientSecret: string;
}

export function createEbayBrowseAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetcher?: typeof fetch,
): EbayBrowseAdapter | undefined {
  const clientId = env.EBAY_CLIENT_ID?.trim();
  const clientSecret = env.EBAY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  return new EbayBrowseAdapter({
    clientId,
    clientSecret,
    marketplaceId: env.EBAY_MARKETPLACE_ID,
    ...(fetcher ? { fetcher } : {}),
  });
}
