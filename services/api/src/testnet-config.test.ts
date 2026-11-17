import { describe, expect, it } from "vitest";
import { loadTestnetRuntimeConfig } from "./testnet-config.js";

const enabledEnv = {
  TESTNET_ENABLED: "true",
  TESTNET_ENVIRONMENT: "TESTNET",
  TESTNET_CONFIG_VERSION: "v1.0.0",
  TESTNET_PROVIDER_ID: "sandbox-exchange",
  TESTNET_ACCOUNT_ID: "sandbox-account-01",
  TESTNET_API_VERSION: "2026-01",
  TESTNET_BASE_URL: "https://sandbox.vendor.example/api/v1/",
  TESTNET_ALLOWED_HOSTS: "sandbox.vendor.example",
  TESTNET_BLOCKED_PRODUCTION_HOSTS: "api.vendor.example",
};

describe("loadTestnetRuntimeConfig", () => {
  it("defaults to a disabled, endpoint-free configuration", () => {
    const config = loadTestnetRuntimeConfig({});
    expect(config).toEqual({ enabled: false, environment: "TESTNET", configVersion: "v0.0.0", providerId: null, accountId: null, apiVersion: null, baseUrl: "https://disabled.invalid/", allowedHosts: [], blockedProductionHosts: [] });
  });

  it("loads a versioned TESTNET configuration with exact identity binding", () => {
    const config = loadTestnetRuntimeConfig(enabledEnv);
    expect(config).toMatchObject({ enabled: true, environment: "TESTNET", configVersion: "v1.0.0", providerId: "sandbox-exchange", accountId: "sandbox-account-01", apiVersion: "2026-01", allowedHosts: ["sandbox.vendor.example"], blockedProductionHosts: ["api.vendor.example"] });
    expect(config.baseUrl).toBe("https://sandbox.vendor.example/api/v1/");
  });

  it("rejects partial or non-TESTNET identity configuration", () => {
    expect(() => loadTestnetRuntimeConfig({ TESTNET_ENABLED: "true" })).toThrow("TESTNET_ENVIRONMENT is required");
    expect(() => loadTestnetRuntimeConfig({ ...enabledEnv, TESTNET_ENVIRONMENT: "LIVE" })).toThrow("must be TESTNET");
    expect(() => loadTestnetRuntimeConfig({ ...enabledEnv, TESTNET_CONFIG_VERSION: "2026-01" })).toThrow("semantic");
    expect(() => loadTestnetRuntimeConfig({ ...enabledEnv, TESTNET_PROVIDER_ID: "../provider" })).toThrow("PROVIDER_ID is invalid");
  });

  it("rejects unsafe URLs, wildcards, and production-host overlap", () => {
    expect(() => loadTestnetRuntimeConfig({ ...enabledEnv, TESTNET_BASE_URL: "http://sandbox.vendor.example/" })).toThrow("HTTPS");
    expect(() => loadTestnetRuntimeConfig({ ...enabledEnv, TESTNET_BASE_URL: "https://attacker.example/" })).toThrow("allowlisted");
    expect(() => loadTestnetRuntimeConfig({ ...enabledEnv, TESTNET_ALLOWED_HOSTS: "*.vendor.example" })).toThrow("exact hostnames");
    expect(() => loadTestnetRuntimeConfig({ ...enabledEnv, TESTNET_BLOCKED_PRODUCTION_HOSTS: "sandbox.vendor.example" })).toThrow("overlap");
    expect(() => loadTestnetRuntimeConfig({ ...enabledEnv, TESTNET_BASE_URL: "https://user:pass@sandbox.vendor.example/" })).toThrow("credentials");
    expect(() => loadTestnetRuntimeConfig({ ...enabledEnv, TESTNET_BASE_URL: "https://sandbox.vendor.example/?token=secret" })).toThrow("query");
  });

  it("rejects invalid boolean and host-list values", () => {
    expect(() => loadTestnetRuntimeConfig({ TESTNET_ENABLED: "yes" })).toThrow("true or false");
    expect(() => loadTestnetRuntimeConfig({ ...enabledEnv, TESTNET_ALLOWED_HOSTS: "sandbox.vendor.example:443" })).toThrow("exact hostnames");
    expect(() => loadTestnetRuntimeConfig({ ...enabledEnv, TESTNET_BLOCKED_PRODUCTION_HOSTS: "*.vendor.example" })).toThrow("exact hostnames");
  });
});
