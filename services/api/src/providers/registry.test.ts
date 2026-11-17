import { describe, expect, it, vi } from "vitest";
import {
  DuplicateProviderError,
  ProviderRegistry,
  UnknownProviderError,
} from "./registry.js";
import {
  CircuitBreaker,
  CircuitOpenError,
} from "./circuit-breaker.js";
import type { ProviderAdapter } from "./types.js";

function adapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    providerId: "demo.provider",
    displayName: "Demo provider",
    capabilities: ["PRODUCT_SEARCH"],
    simulated: true,
    healthCheck: vi.fn(async () => ({
      status: "HEALTHY" as const,
      checkedAt: new Date(0).toISOString(),
    })),
    searchProducts: vi.fn(async () => []),
    ...overrides,
  };
}

describe("ProviderRegistry", () => {
  it("registers an adapter and exposes only its declared capabilities", () => {
    const registry = new ProviderRegistry();
    const provider = adapter();
    registry.register(provider);

    expect(registry.get("demo.provider")).toBe(provider);
    expect(registry.getForCapability("demo.provider", "PRODUCT_SEARCH")).toBe(provider);
    expect(registry.list()).toEqual([{
      providerId: "demo.provider",
      displayName: "Demo provider",
      capabilities: ["PRODUCT_SEARCH"],
      simulated: true,
    }]);
  });

  it("rejects duplicate provider IDs", () => {
    const registry = new ProviderRegistry();
    registry.register(adapter());
    expect(() => registry.register(adapter())).toThrow(DuplicateProviderError);
  });

  it("rejects unknown providers and undeclared capabilities", () => {
    const registry = new ProviderRegistry();
    registry.register(adapter());
    expect(() => registry.get("missing.provider")).toThrow(UnknownProviderError);
    expect(() => registry.getForCapability("demo.provider", "PRICE_LOOKUP"))
      .toThrow(/does not support PRICE_LOOKUP/);
  });

  it("rejects capabilities without a corresponding implementation", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.register(adapter({
      capabilities: ["PRICE_LOOKUP"],
      getPrice: undefined,
    }))).toThrow(/without implementing it/);
  });

  it("rejects malformed provider identifiers", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.register(adapter({ providerId: "Bad ID" })))
      .toThrow(/Provider IDs/);
  });
});

describe("CircuitBreaker", () => {
  it("opens after the configured number of failures and rejects calls", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100 });
    const failing = vi.fn(async () => { throw new Error("provider down"); });

    await expect(breaker.execute(failing)).rejects.toThrow("provider down");
    await expect(breaker.execute(failing)).rejects.toThrow("provider down");
    expect(breaker.getState()).toBe("OPEN");
    await expect(breaker.execute(failing)).rejects.toThrow(CircuitOpenError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("allows one half-open probe after cooldown and closes on success", async () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 50,
      now: () => now,
    });
    await expect(breaker.execute(async () => { throw new Error("offline"); }))
      .rejects.toThrow("offline");
    expect(breaker.getState()).toBe("OPEN");

    now += 50;
    expect(breaker.getState()).toBe("HALF_OPEN");
    await expect(breaker.execute(async () => "ok")).resolves.toBe("ok");
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("reopens when the half-open probe fails", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10,
      now: () => now,
    });
    await expect(breaker.execute(async () => { throw new Error("first"); }))
      .rejects.toThrow("first");
    now = 10;
    await expect(breaker.execute(async () => { throw new Error("probe"); }))
      .rejects.toThrow("probe");
    expect(breaker.getState()).toBe("OPEN");
  });
});
