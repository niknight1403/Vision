import { Buffer } from "node:buffer";
import type {
  ProductSearchRequest,
  ProviderAdapter,
  ProviderHealth,
  ProviderProduct,
} from "./types.js";

const API_ORIGIN = "https://api.ebay.com";
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
const TOKEN_PATH = "/identity/v1/oauth2/token";
const SEARCH_PATH = "/buy/browse/v1/item_summary/search";

export interface EbayBrowseConfig {
  clientId: string;
  clientSecret: string;
  marketplaceId: string;
}

export function loadEbayBrowseConfig(
  env: NodeJS.ProcessEnv = process.env,
): EbayBrowseConfig | null {
  const clientId = env.EBAY_CLIENT_ID?.trim();
  const clientSecret = env.EBAY_CLIENT_SECRET?.trim();
  const marketplaceId = env.EBAY_MARKETPLACE_ID?.trim() || "EBAY_DE";
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new Error("EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be configured together");
  }
  if (!/^[A-Z_]{3,24}$/.test(marketplaceId)) {
    throw new Error("EBAY_MARKETPLACE_ID is invalid");
  }
  return { clientId, clientSecret, marketplaceId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function priceToMinor(value: unknown): number {
  if (typeof value !== "string" || !/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("EBAY_RESPONSE_INVALID_PRICE");
  }
  const [whole, fraction = ""] = value.split(".");
  const minor = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("EBAY_RESPONSE_PRICE_OUT_OF_RANGE");
  return Number(minor);
}

function parseItem(value: unknown, currency: string, observedAt: string): ProviderProduct {
  if (!isRecord(value) || !isRecord(value.price)) throw new Error("EBAY_RESPONSE_INVALID_ITEM");
  const itemId = value.itemId;
  const title = value.title;
  const itemWebUrl = value.itemWebUrl;
  const itemCurrency = value.price.currency;
  if (
    typeof itemId !== "string" || !itemId.trim() ||
    typeof title !== "string" || !title.trim() ||
    typeof itemWebUrl !== "string" ||
    typeof itemCurrency !== "string" || itemCurrency !== currency
  ) {
    throw new Error("EBAY_RESPONSE_INVALID_ITEM");
  }
  let url: URL;
  try { url = new URL(itemWebUrl); } catch { throw new Error("EBAY_RESPONSE_INVALID_ITEM_URL"); }
  if (url.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)*ebay\.(?:[a-z]{2,3}|co\.[a-z]{2})$/i.test(url.hostname)) {
    throw new Error("EBAY_RESPONSE_INVALID_ITEM_URL");
  }
  return {
    providerId: "ebay",
    externalId: itemId,
    title,
    url: url.toString(),
    currency,
    priceMinor: priceToMinor(value.price.value),
    observedAt,
    simulated: false,
  };
}

/** Read-only eBay Buy Browse adapter. It cannot place bids, buy, message sellers, or mutate listings. */
export class EbayBrowseAdapter implements ProviderAdapter {
  readonly providerId = "ebay";
  readonly displayName = "eBay Browse API";
  readonly capabilities = ["PRODUCT_SEARCH"] as const;
  readonly simulated = false;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly config: EbayBrowseConfig) {}

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      await this.getAccessToken(signal);
      return { status: "HEALTHY", checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt };
    } catch {
      return {
        status: "DEGRADED",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        message: "eBay OAuth health check failed; details withheld",
      };
    }
  }

  async searchProducts(
    request: ProductSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly ProviderProduct[]> {
    const query = request.query.trim();
    const currency = request.currency.toUpperCase();
    if (!query || query.length > 100) throw new Error("eBay query must contain 1-100 characters");
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
      throw new Error("eBay search limit must be between 1 and 50");
    }
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter code");

    const token = await this.getAccessToken(signal);
    const url = new URL(SEARCH_PATH, API_ORIGIN);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(request.limit));
    const response = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "x-ebay-c-marketplace-id": this.config.marketplaceId,
      },
      signal: signal ?? AbortSignal.timeout(12_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`EBAY_SEARCH_HTTP_${response.status}`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.itemSummaries)) {
      throw new Error("EBAY_RESPONSE_INVALID_ITEMS");
    }
    if (payload.itemSummaries.length > request.limit) throw new Error("EBAY_RESPONSE_LIMIT_EXCEEDED");
    const observedAt = new Date().toISOString();
    return payload.itemSummaries.map((item) => parseItem(item, currency, observedAt));
  }

  private async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, "utf8").toString("base64");
    const response = await fetch(new URL(TOKEN_PATH, API_ORIGIN), {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: OAUTH_SCOPE,
      }),
      signal: signal ?? AbortSignal.timeout(12_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`EBAY_OAUTH_HTTP_${response.status}`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.access_token !== "string" ||
        !payload.access_token || typeof payload.expires_in !== "number" ||
        !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
      throw new Error("EBAY_OAUTH_RESPONSE_INVALID");
    }
    this.accessToken = payload.access_token;
    this.tokenExpiresAt = Date.now() + payload.expires_in * 1000;
    return this.accessToken;
  }
}
