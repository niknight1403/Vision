import { describe, expect, it } from "vitest";
import { loadProviderRuntimeConfig } from "./provider-config.js";

describe("loadProviderRuntimeConfig", () => {
  it("returns disabled without exposing a provider endpoint when unset", () => {
    const config = loadProviderRuntimeConfig("example", {});
    expect(config.enabled).toBe(false);
    expect(config.allowedHosts).toEqual([]);
    expect("bearerToken" in config).toBe(false);
  });

  it("loads an exact HTTPS allowlist and server-side token", () => {
    const config = loadProviderRuntimeConfig("example", {
      PROVIDER_EXAMPLE_BASE_URL: "https://api.vendor.example/v2/",
      PROVIDER_EXAMPLE_ALLOWED_HOSTS: "api.vendor.example",
      PROVIDER_EXAMPLE_API_TOKEN: "opaque-server-token",
    });
    expect(config).toMatchObject({
      providerId: "example",
      enabled: true,
      allowedHosts: ["api.vendor.example"],
      bearerToken: "opaque-server-token",
      timeoutMs: 8_000,
    });
  });

  it("rejects wildcard hosts and host mismatches", () => {
    expect(() => loadProviderRuntimeConfig("example", {
      PROVIDER_EXAMPLE_BASE_URL: "https://api.vendor.example/",
      PROVIDER_EXAMPLE_ALLOWED_HOSTS: "*.vendor.example",
    })).toThrow(/exact hostnames/);

    expect(() => loadProviderRuntimeConfig("example", {
      PROVIDER_EXAMPLE_BASE_URL: "https://attacker.example/",
      PROVIDER_EXAMPLE_ALLOWED_HOSTS: "api.vendor.example",
    })).toThrow(/exact allowlisted hostname/);
  });

  it("rejects partial configuration and weak tokens", () => {
    expect(() => loadProviderRuntimeConfig("example", {
      PROVIDER_EXAMPLE_API_TOKEN: "secret-token",
    })).toThrow(/must be configured together/);

    expect(() => loadProviderRuntimeConfig("example", {
      PROVIDER_EXAMPLE_BASE_URL: "https://api.vendor.example/",
      PROVIDER_EXAMPLE_ALLOWED_HOSTS: "api.vendor.example",
      PROVIDER_EXAMPLE_API_TOKEN: "bad token",
    })).toThrow(/opaque token/);
  });

  it("rejects unsafe provider IDs", () => {
    expect(() => loadProviderRuntimeConfig("../example", {})).toThrow(/Invalid provider/);
  });
});
