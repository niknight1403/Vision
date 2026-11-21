import { describe, expect, it } from "vitest";
import { createConfiguredProviderRegistry } from "./bootstrap.js";

describe("provider bootstrap", () => {
  it("does not register synthetic data by default", () => {
    const registry = createConfiguredProviderRegistry({ NODE_ENV: "production" });
    expect(registry.list()).toEqual([]);
  });

  it("rejects synthetic provider outside staging", () => {
    expect(() => createConfiguredProviderRegistry({
      NODE_ENV: "production",
      STAGING_PROVIDER_ENABLED: "true",
      STAGING_SYNTHETIC_DATA_ACK: "I_UNDERSTAND_SYNTHETIC_DATA",
    })).toThrow("STAGING_PROVIDER_REQUIRES_STAGING_NODE_ENV");
  });

  it("requires an explicit synthetic-data acknowledgement", () => {
    expect(() => createConfiguredProviderRegistry({
      NODE_ENV: "staging",
      STAGING_PROVIDER_ENABLED: "true",
    })).toThrow("STAGING_SYNTHETIC_DATA_ACK_REQUIRED");
  });

  it("registers only the synthetic staging provider with both gates", () => {
    const registry = createConfiguredProviderRegistry({
      NODE_ENV: "staging",
      STAGING_PROVIDER_ENABLED: "true",
      STAGING_SYNTHETIC_DATA_ACK: "I_UNDERSTAND_SYNTHETIC_DATA",
    });
    expect(registry.list()).toEqual([{
      providerId: "catalog-staging",
      displayName: "Synthetic staging catalog",
      capabilities: ["PRODUCT_SEARCH"],
      simulated: true,
    }]);
  });
});
