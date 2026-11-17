import { describe, expect, it, vi, afterEach } from "vitest";
import { CatalogRestAdapter } from "./catalog-rest-adapter.js";
import type { ProviderRuntimeConfig } from "./provider-config.js";

const config: ProviderRuntimeConfig = {
  providerId: "catalog-demo",
  enabled: true,
  baseUrl: "https://catalog.example/v1/",
  allowedHosts: ["catalog.example"],
};

afterEach(() => vi.unstubAllGlobals());

describe("CatalogRestAdapter", () => {
  it("normalizes a read-only product search response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      items: [{
        id: "sku-1",
        title: "Camera",
        url: "https://catalog.example/products/sku-1",
        currency: "EUR",
        priceMinor: 12999,
        observedAt: "2026-11-17T00:00:00.000Z",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const adapter = new CatalogRestAdapter(config, "Contract test catalog");
    await expect(adapter.searchProducts({ query: "camera", limit: 10, currency: "eur" }))
      .resolves.toMatchObject([{
        providerId: "catalog-demo",
        externalId: "sku-1",
        priceMinor: 12999,
        simulated: false,
      }]);
  });

  it("rejects invalid query bounds before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new CatalogRestAdapter(config, "Contract test catalog");
    await expect(adapter.searchProducts({ query: " ", limit: 10, currency: "EUR" }))
      .rejects.toThrow(/query/);
    await expect(adapter.searchProducts({ query: "camera", limit: 100, currency: "EUR" }))
      .rejects.toThrow(/limit/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed product payloads and non-HTTPS product links", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      items: [{
        id: "sku-1",
        title: "Camera",
        url: "http://unsafe.example/item",
        currency: "EUR",
        priceMinor: 100,
        observedAt: "2026-11-17T00:00:00.000Z",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const adapter = new CatalogRestAdapter(config, "Contract test catalog");
    await expect(adapter.searchProducts({ query: "camera", limit: 10, currency: "EUR" }))
      .rejects.toThrow(/HTTPS/);
  });

  it("does not construct an adapter when provider configuration is disabled", () => {
    expect(() => new CatalogRestAdapter({
      ...config,
      enabled: false,
    }, "Disabled")).toThrow(/disabled/);
  });
});
