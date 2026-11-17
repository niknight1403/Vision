import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderHttpClient } from "./providers/http-client.js";
import { loadTestnetRuntimeConfig } from "./testnet-config.js";
import { validateTestnetReadOnlyAdapter, type TestnetReadOnlyAdapter } from "./testnet-provider-contract.js";

const env = {
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

const readOnlyAdapter = (): TestnetReadOnlyAdapter => ({
  providerId: "sandbox-exchange",
  environment: "TESTNET",
  capabilities: ["HEALTH_READ", "INSTRUMENTS_READ", "BALANCE_READ", "OPEN_ORDERS_READ", "ORDER_STATUS_READ", "FILLS_READ"],
  async healthCheck() { return { status: "HEALTHY", checkedAt: "2026-11-17T00:00:00.000Z", latencyMs: 2 }; },
  async getInstruments() { return ["DEMO-EUR"]; },
  async getBalances() { return [{ asset: "EUR", availableMinor: 10_000n, lockedMinor: 0n }]; },
  async getOpenOrders() { return []; },
  async getOrderStatus() { return null; },
  async getFills() { return []; },
});

afterEach(() => vi.unstubAllGlobals());

describe("TESTNET integration contract (local fixtures only)", () => {
  it("composes versioned environment binding with the allowlisted JSON client", async () => {
    const runtime = loadTestnetRuntimeConfig(env);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(url.origin).toBe("https://sandbox.vendor.example");
      expect(url.pathname).toBe("/api/v1/health");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response(JSON.stringify({ status: "HEALTHY", environment: runtime.environment, apiVersion: runtime.apiVersion }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProviderHttpClient({ baseUrl: runtime.baseUrl, allowedHosts: runtime.allowedHosts, timeoutMs: 250, maxResponseBytes: 10_000 });
    await expect(client.getJson("health")).resolves.toEqual({ status: "HEALTHY", environment: "TESTNET", apiVersion: "2026-01" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts only implemented read-only capabilities", async () => {
    const adapter = readOnlyAdapter();
    validateTestnetReadOnlyAdapter(adapter);
    await expect(adapter.healthCheck()).resolves.toMatchObject({ status: "HEALTHY" });
    await expect(adapter.getBalances?.()).resolves.toEqual([{ asset: "EUR", availableMinor: 10_000n, lockedMinor: 0n }]);
    expect(adapter.capabilities).not.toContain("ORDER_SUBMIT");
    expect(adapter.capabilities).not.toContain("CANCEL_ORDER");
  });

  it("rejects incomplete, duplicate, or wrong-environment adapters", () => {
    expect(() => validateTestnetReadOnlyAdapter({ ...readOnlyAdapter(), environment: "LIVE" as unknown as "TESTNET" })).toThrow("ENVIRONMENT_INVALID");
    expect(() => validateTestnetReadOnlyAdapter({ ...readOnlyAdapter(), capabilities: ["BALANCE_READ", "BALANCE_READ"] })).toThrow("DUPLICATE");
    expect(() => validateTestnetReadOnlyAdapter({ ...readOnlyAdapter(), capabilities: ["ORDER_STATUS_READ"], getOrderStatus: undefined })).toThrow("NOT_IMPLEMENTED");
  });

  it("rejects redirect and escaped-path behavior through the same client boundary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://api.vendor.example/production" } })));
    const client = new ProviderHttpClient({ baseUrl: env.TESTNET_BASE_URL, allowedHosts: ["sandbox.vendor.example"] });
    await expect(client.getJson("health")).rejects.toThrow(/HTTP 302/);
    await expect(client.getJson("/production/orders")).rejects.toThrow(/escaped/);
  });
});
