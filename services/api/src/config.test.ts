import { afterEach, describe, expect, it, vi } from "vitest";

describe("autonomous trading configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to autonomous provider-backed operation", async () => {
    vi.stubEnv("TRADING_MODE", "AUTONOMOUS");
    vi.stubEnv("LIVE_TRADING_ENABLED", "false");
    vi.stubEnv("EMERGENCY_STOP", "true");

    const { config } = await import("./config.js");
    expect(config.tradingMode).toBe("AUTONOMOUS");
    expect(config.liveTradingEnabled).toBe(false);
  });

  it("rejects legacy PAPER mode", async () => {
    vi.stubEnv("TRADING_MODE", "PAPER");
    vi.stubEnv("LIVE_TRADING_ENABLED", "false");
    await expect(import("./config.js")).rejects.toThrow("TRADING_MODE must be AUTONOMOUS");
  });

  it("rejects mutating execution until a reviewed provider adapter exists", async () => {
    vi.stubEnv("TRADING_MODE", "AUTONOMOUS");
    vi.stubEnv("LIVE_TRADING_ENABLED", "true");
    await expect(import("./config.js")).rejects.toThrow("reviewed provider adapter");
  });

  it("keeps testnet execution disabled", async () => {
    vi.stubEnv("TRADING_MODE", "AUTONOMOUS");
    vi.stubEnv("LIVE_TRADING_ENABLED", "false");
    vi.stubEnv("TESTNET_ENABLED", "true");
    vi.stubEnv("TESTNET_ENVIRONMENT", "TESTNET");
    vi.stubEnv("TESTNET_CONFIG_VERSION", "v1.0.0");
    vi.stubEnv("TESTNET_PROVIDER_ID", "sandbox-exchange");
    vi.stubEnv("TESTNET_ACCOUNT_ID", "sandbox-account-01");
    vi.stubEnv("TESTNET_API_VERSION", "2026-01");
    vi.stubEnv("TESTNET_BASE_URL", "https://sandbox.vendor.example/api/v1/");
    vi.stubEnv("TESTNET_ALLOWED_HOSTS", "sandbox.vendor.example");
    vi.stubEnv("TESTNET_BLOCKED_PRODUCTION_HOSTS", "api.vendor.example");

    await expect(import("./config.js")).rejects.toThrow("TESTNET execution is not enabled");
  });
});
