import { afterEach, describe, expect, it, vi } from "vitest";
import { EbayBrowseAdapter, loadEbayBrowseConfig } from "./ebay-browse-adapter.js";

const config = { clientId: "client-id", clientSecret: "client-secret", marketplaceId: "EBAY_DE" };
const tokenPayload = { access_token: "test-access-token", expires_in: 7200, token_type: "Application Access Token" };

afterEach(() => vi.unstubAllGlobals());

describe("eBay Browse adapter", () => {
  it("loads credentials fail-closed and defaults to the German marketplace", () => {
    expect(loadEbayBrowseConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(() => loadEbayBrowseConfig({ EBAY_CLIENT_ID: "only-one" } as NodeJS.ProcessEnv))
      .toThrow(/configured together/);
    expect(loadEbayBrowseConfig({
      EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret",
    } as NodeJS.ProcessEnv)).toEqual({ clientId: "id", clientSecret: "secret", marketplaceId: "EBAY_DE" });
  });

  it("obtains an app token and normalizes real-shaped item summaries as non-simulated", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(tokenPayload), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ itemSummaries: [{
        itemId: "v1|123|0", title: "Vintage camera", itemWebUrl: "https://www.ebay.de/itm/123",
        price: { value: "19.95", currency: "EUR" },
      }] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new EbayBrowseAdapter(config);
    await expect(adapter.searchProducts({ query: "vintage camera", limit: 10, currency: "EUR" }))
      .resolves.toMatchObject([{
        providerId: "ebay", externalId: "v1|123|0", title: "Vintage camera",
        priceMinor: 1995, currency: "EUR", simulated: false,
      }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0].toString()).toContain("item_summary/search");
    expect(fetchMock.mock.calls[1][1].headers["x-ebay-c-marketplace-id"]).toBe("EBAY_DE");
  });

  it("caches the application token between searches", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(tokenPayload), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValue(new Response(JSON.stringify({ itemSummaries: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new EbayBrowseAdapter(config);
    await adapter.searchProducts({ query: "camera", limit: 5, currency: "EUR" });
    await adapter.searchProducts({ query: "lens", limit: 5, currency: "EUR" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects unsafe links, mismatched currencies and invalid search bounds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(tokenPayload), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValue(new Response(JSON.stringify({ itemSummaries: [{
        itemId: "1", title: "Item", itemWebUrl: "https://evil.example/item",
        price: { value: "10.00", currency: "EUR" },
      }] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new EbayBrowseAdapter(config);
    await expect(adapter.searchProducts({ query: "camera", limit: 5, currency: "EUR" }))
      .rejects.toThrow(/URL/);
    await expect(adapter.searchProducts({ query: " ", limit: 5, currency: "EUR" }))
      .rejects.toThrow(/query/);
  });
});
