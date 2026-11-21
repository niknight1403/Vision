import { describe, expect, it } from "vitest";
import { StagingCatalogAdapter } from "./staging-catalog-adapter.js";

describe("StagingCatalogAdapter", () => {
  it("is explicitly synthetic and returns only matching staging products", async () => {
    const adapter = new StagingCatalogAdapter();
    expect(adapter.simulated).toBe(true);
    expect(adapter.capabilities).toEqual(["PRODUCT_SEARCH"]);

    await expect(adapter.searchProducts({ query: "Kamera", limit: 10, currency: "EUR" }))
      .resolves.toMatchObject([{
        providerId: "catalog-staging",
        externalId: "staging-camera-001",
        simulated: true,
        currency: "EUR",
      }]);
  });

  it("reports the synthetic staging boundary in health", async () => {
    await expect(new StagingCatalogAdapter().healthCheck()).resolves.toMatchObject({
      status: "HEALTHY",
      latencyMs: 0,
      message: expect.stringContaining("Synthetic staging data"),
    });
  });

  it("rejects unsupported input before searching", async () => {
    const adapter = new StagingCatalogAdapter();
    await expect(adapter.searchProducts({ query: "Kamera", limit: 10, currency: "USD" }))
      .rejects.toThrow("EUR only");
    await expect(adapter.searchProducts({ query: " ", limit: 10, currency: "EUR" }))
      .rejects.toThrow("1-200");
  });

  it("honours an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new StagingCatalogAdapter().searchProducts(
      { query: "Kamera", limit: 10, currency: "EUR" },
      controller.signal,
    )).rejects.toThrow();
  });
});
