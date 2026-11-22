import { describe, expect, it } from "vitest";
import {
  InProcessRateLimiter,
  rateLimitConfigFromEnv,
  redactSensitive,
  retryAfterSeconds,
  SlidingWindowRateLimiter,
} from "./api-hardening.js";
describe("API hardening", () => {
  it("limits a key within a window", () => { const limiter = new InProcessRateLimiter(2, 1000); expect(limiter.allow("scan", 1000)).toBe(true); expect(limiter.allow("scan", 1100)).toBe(true); expect(limiter.allow("scan", 1200)).toBe(false); expect(limiter.allow("scan", 2201)).toBe(true); });
  it("redacts credentials and URLs", () => { const result = redactSensitive("authorization=Bearer-secret https://private.example/image?token=abc"); expect(result).not.toContain("Bearer-secret"); expect(result).not.toContain("private.example"); });
});

describe("sliding-window limiter", () => {
  it("reports the wait time and remaining budget", () => {
    const limiter = new SlidingWindowRateLimiter(2, 10_000);
    const first = limiter.check("user:a", 1_000);
    expect(first).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    const second = limiter.check("user:a", 2_000);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);
    const blocked = limiter.check("user:a", 3_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(8_000);
    expect(retryAfterSeconds(blocked)).toBe(8);
  });

  it("reopens exactly when the oldest hit leaves the window", () => {
    const limiter = new SlidingWindowRateLimiter(1, 5_000);
    expect(limiter.allow("k", 1_000)).toBe(true);
    expect(limiter.allow("k", 5_999)).toBe(false);
    expect(limiter.allow("k", 6_001)).toBe(true);
  });

  it("keeps principals independent", () => {
    const limiter = new SlidingWindowRateLimiter(1, 5_000);
    expect(limiter.allow("user:a", 1_000)).toBe(true);
    expect(limiter.allow("user:b", 1_000)).toBe(true);
    expect(limiter.allow("user:a", 1_001)).toBe(false);
  });

  it("bounds the tracked key map and evicts the least recently used key", () => {
    const limiter = new SlidingWindowRateLimiter(1, 60_000, 3);
    for (const key of ["a", "b", "c"]) limiter.allow(key, 1_000);
    limiter.allow("a", 2_000); // still blocked, but marks "a" as recently used
    expect(limiter.trackedKeys).toBe(3);
    limiter.allow("d", 3_000);
    expect(limiter.trackedKeys).toBe(3);
    // "b" was the least recently used entry and is gone, so it starts fresh.
    expect(limiter.check("b", 3_100).allowed).toBe(true);
  });

  it("drops expired keys instead of evicting live ones", () => {
    const limiter = new SlidingWindowRateLimiter(1, 1_000, 2);
    limiter.allow("old", 1_000);
    limiter.allow("live", 10_000);
    limiter.allow("new", 10_100);
    expect(limiter.trackedKeys).toBe(2);
    expect(limiter.check("live", 10_200).allowed).toBe(false);
  });

  it("rejects an unusable configuration instead of guessing", () => {
    expect(() => new SlidingWindowRateLimiter(0, 1_000)).toThrow("RATE_LIMIT_CONFIG_INVALID");
    expect(() => new SlidingWindowRateLimiter(1, 999)).toThrow("RATE_LIMIT_CONFIG_INVALID");
    expect(() => new SlidingWindowRateLimiter(1, 1_000, 0)).toThrow("RATE_LIMIT_CONFIG_INVALID");
    expect(() => new SlidingWindowRateLimiter(1.5, 1_000)).toThrow("RATE_LIMIT_CONFIG_INVALID");
  });

  it("reads a bounded configuration from the environment", () => {
    const defaults = { maxHits: 10, windowMs: 60_000 };
    const names = { max: "AUTH_RATE_LIMIT_MAX", window: "AUTH_RATE_LIMIT_WINDOW_MS" };
    expect(rateLimitConfigFromEnv({}, names, defaults)).toEqual({ maxHits: 10, windowMs: 60_000, maxKeys: 10_000 });
    expect(rateLimitConfigFromEnv({ AUTH_RATE_LIMIT_MAX: "5", RATE_LIMIT_MAX_KEYS: "50" }, names, defaults))
      .toEqual({ maxHits: 5, windowMs: 60_000, maxKeys: 50 });
    expect(() => rateLimitConfigFromEnv({ AUTH_RATE_LIMIT_MAX: "0" }, names, defaults)).toThrow("RATE_LIMIT_CONFIG_INVALID");
    expect(() => rateLimitConfigFromEnv({ AUTH_RATE_LIMIT_MAX: "abc" }, names, defaults)).toThrow("RATE_LIMIT_CONFIG_INVALID");
    expect(() => rateLimitConfigFromEnv({ AUTH_RATE_LIMIT_WINDOW_MS: "10" }, names, defaults)).toThrow("RATE_LIMIT_CONFIG_INVALID");
    expect(() => rateLimitConfigFromEnv({ AUTH_RATE_LIMIT_MAX: "100001" }, names, defaults)).toThrow("RATE_LIMIT_CONFIG_INVALID");
  });
});
