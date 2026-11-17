import { afterEach, describe, expect, it, vi } from "vitest";

describe("demo-only trading configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to PAPER with live trading disabled", async () => {
    vi.stubEnv("TRADING_MODE", "PAPER");
    vi.stubEnv("LIVE_TRADING_ENABLED", "false");
    vi.stubEnv("EMERGENCY_STOP", "true");

    const { config } = await import("./config.js");
    expect(config.tradingMode).toBe("PAPER");
    expect(config.liveTradingEnabled).toBe(false);
  });

  it("rejects LIVE mode even when the old opt-in flags are set", async () => {
    vi.stubEnv("TRADING_MODE", "LIVE");
    vi.stubEnv("LIVE_TRADING_ENABLED", "true");
    vi.stubEnv("EMERGENCY_STOP", "false");

    await expect(import("./config.js")).rejects.toThrow("LIVE trading is disabled");
  });

  it("rejects an attempt to enable LIVE while mode remains PAPER", async () => {
    vi.stubEnv("TRADING_MODE", "PAPER");
    vi.stubEnv("LIVE_TRADING_ENABLED", "true");
    vi.stubEnv("EMERGENCY_STOP", "true");

    await expect(import("./config.js")).rejects.toThrow("LIVE trading is disabled");
  });

  it("rejects an otherwise valid TESTNET configuration until the release gate enables it", async () => {
    vi.stubEnv("TRADING_MODE", "PAPER");
    vi.stubEnv("LIVE_TRADING_ENABLED", "false");
    vi.stubEnv("EMERGENCY_STOP", "true");
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
