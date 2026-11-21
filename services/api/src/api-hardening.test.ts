import { describe, expect, it } from "vitest";
import { InProcessRateLimiter, redactSensitive } from "./api-hardening.js";
describe("API hardening", () => {
  it("limits a key within a window", () => { const limiter = new InProcessRateLimiter(2, 1000); expect(limiter.allow("scan", 1000)).toBe(true); expect(limiter.allow("scan", 1100)).toBe(true); expect(limiter.allow("scan", 1200)).toBe(false); expect(limiter.allow("scan", 2201)).toBe(true); });
  it("redacts credentials and URLs", () => { const result = redactSensitive("authorization=Bearer-secret https://private.example/image?token=abc"); expect(result).not.toContain("Bearer-secret"); expect(result).not.toContain("private.example"); });
});
