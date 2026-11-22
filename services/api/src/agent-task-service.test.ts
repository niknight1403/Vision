import { describe, expect, it } from "vitest";
import { canonicalizeTaskInput, hashTaskInput } from "./agent-task-service.js";

describe("agent task lifecycle contract", () => {
  it("documents terminal and resumable states", () => {
    const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"];
    const resumable = ["QUEUED", "CHECKPOINTED"];
    expect(terminal).toHaveLength(3);
    expect(resumable).toContain("CHECKPOINTED");
  });

  it("hashes JSON objects canonically while preserving array order", () => {
    const left = { z: { second: 2, first: 1 }, a: [{ y: true, x: "value" }] };
    const right = { a: [{ x: "value", y: true }], z: { first: 1, second: 2 } };
    expect(hashTaskInput(left)).toBe(hashTaskInput(right));
    expect(canonicalizeTaskInput(left)).toEqual({ a: [{ x: "value", y: true }], z: { first: 1, second: 2 } });
    expect(hashTaskInput({ values: [1, 2] })).not.toBe(hashTaskInput({ values: [2, 1] }));
  });

  it("rejects non-JSON values and cyclic task input", () => {
    expect(() => hashTaskInput({ value: Number.NaN })).toThrow("TASK_INPUT_NOT_JSON");
    expect(() => hashTaskInput({ value: undefined })).toThrow("TASK_INPUT_NOT_JSON");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => hashTaskInput(cyclic)).toThrow("TASK_INPUT_NOT_JSON");
    expect(() => hashTaskInput([])).toThrow("TASK_INPUT_MUST_BE_OBJECT");
  });
});

describe("canonical task input hashing", () => {
  it("is independent of key order so route and service agree on the idempotency hash", () => {
    const first = hashTaskInput({ dealId: "d1", imageUrl: "https://x.test/a.jpg", currency: "EUR" });
    const reordered = hashTaskInput({ currency: "EUR", imageUrl: "https://x.test/a.jpg", dealId: "d1" });
    expect(first).toBe(reordered);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any bound input value changes", () => {
    const base = { dealId: "d1", imageUrl: "https://x.test/a.jpg" };
    expect(hashTaskInput(base)).not.toBe(hashTaskInput({ ...base, imageUrl: "https://x.test/b.jpg" }));
  });

  it("rejects non-object input", () => {
    expect(() => hashTaskInput(["a"])).toThrow("TASK_INPUT_MUST_BE_OBJECT");
  });
});
