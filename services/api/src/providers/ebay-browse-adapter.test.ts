import { afterEach, describe, expect, it, vi } from "vitest";
import { EbayBrowseAdapter, createEbayBrowseAdapterFromEnv } from "./ebay-browse-adapter.js";

afterEach(() => vi.unstubAllGlobals());

describe("EbayBrowseAdapter", () => {
  it("uses the application OAuth flow and normalizes real EUR listings", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth2/token")) {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Basic ${Buffer.from("test-client:test-secret").toString("base64")}`,
        );
        expect(String(init?.body)).toContain("grant_type=client_credentials");
        return new Response(JSON.stringify({ access_token: "safe-test-token", expires_in: 7200 }), { status: 200 });
      }
      const search = new URL(url);
      expect(["camera", "camera bag"]).toContain(search.searchParams.get("q"));
      expect(search.searchParams.get("limit")).toBe("10");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer safe-test-token");
      expect(new Headers(init?.headers).get("x-ebay-c-marketplace-id")).toBe("EBAY_DE");
      return new Response(JSON.stringify({ itemSummaries: [{
        itemId: "v1|item-1|0",
        title: "Used camera",
        itemWebUrl: "https://www.ebay.de/itm/item-1",
        image: { imageUrl: "https://i.ebayimg.com/images/test.jpg" },
        price: { value: "129.90", currency: "EUR" },
      }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayBrowseAdapter({ clientId: "test-client", clientSecret: "test-secret" });
    const result = await adapter.searchProducts({ query: "camera", limit: 10, currency: "EUR" });
    expect(result).toEqual([{
      providerId: "ebay",
      externalId: "v1|item-1|0",
      title: "Used camera",
      url: "https://www.ebay.de/itm/item-1",
      imageUrl: "https://i.ebayimg.com/images/test.jpg",
      currency: "EUR",
      priceMinor: 12_990,
      observedAt: expect.any(String),
      simulated: false,
    }]);
    await adapter.searchProducts({ query: "camera bag", limit: 10, currency: "EUR" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid requests before calling eBay", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new EbayBrowseAdapter({ clientId: "test-client", clientSecret: "test-secret" });
    await expect(adapter.searchProducts({ query: " ", limit: 10, currency: "EUR" }))
      .rejects.toThrow(/query/);
    await expect(adapter.searchProducts({ query: "camera", limit: 51, currency: "EUR" }))
      .rejects.toThrow(/limit/);
    await expect(adapter.searchProducts({ query: "camera", limit: 10, currency: "USD" }))
      .rejects.toThrow(/EUR/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not create a provider unless both server credentials are configured", () => {
    expect(createEbayBrowseAdapterFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(createEbayBrowseAdapterFromEnv({
      EBAY_CLIENT_ID: "client-only",
    } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("rejects non-HTTPS listing links instead of returning them to clients", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "safe-test-token", expires_in: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ itemSummaries: [{
        itemId: "unsafe-item",
        title: "Unsafe URL",
        itemWebUrl: "http://example.invalid/item",
        price: { value: "1.00", currency: "EUR" },
      }] }), { status: 200 });
    }));
    const adapter = new EbayBrowseAdapter({ clientId: "test-client", clientSecret: "test-secret" });
    await expect(adapter.searchProducts({ query: "unsafe", limit: 1, currency: "EUR" })).resolves.toEqual([]);
  });
});
