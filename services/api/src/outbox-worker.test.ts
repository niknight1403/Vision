import { describe, expect, it } from "vitest";
import { retryDelaySeconds, sanitizeOutboxError } from "./outbox-worker.js";

describe("outbox retry policy", () => {
  it("uses bounded exponential backoff", () => {
    expect(retryDelaySeconds(1, 5)).toBe(5);
    expect(retryDelaySeconds(2, 5)).toBe(10);
    expect(retryDelaySeconds(3, 5)).toBe(20);
  });
  it("caps delay and guards extreme attempts", () => {
    expect(retryDelaySeconds(20, 5)).toBe(3600);
    expect(retryDelaySeconds(0, 5)).toBe(5);
  });
  it("redacts credentials from persisted error details", () => {
    expect(sanitizeOutboxError(new Error("Authorization: Bearer abc123 api_key=sk-secret password=hunter2")))
      .toBe("Authorization: [REDACTED] api_key=[REDACTED] password=[REDACTED]");
    expect(sanitizeOutboxError(new Error("request failed https://user:pass@example.test/path")))
      .toBe("request failed https://[REDACTED]@example.test/path");
  });
  it("rejects invalid retry configuration", () => {
    expect(() => retryDelaySeconds(1, 0)).toThrow("INVALID_BASE_RETRY_SECONDS");
    expect(() => retryDelaySeconds(1, Number.NaN)).toThrow("INVALID_BASE_RETRY_SECONDS");
  });
});
