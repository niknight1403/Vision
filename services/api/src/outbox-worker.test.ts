import { describe, expect, it } from "vitest";
import { redactOutboxError, retryDelaySeconds } from "./outbox-worker.js";

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
  it("redacts credentials and URLs from handler errors", () => {
    const value = redactOutboxError(new Error("token=abc123 failed https://private.example/x"));
    expect(value).not.toContain("abc123");
    expect(value).not.toContain("private.example");
  });
});
