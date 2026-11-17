import { describe, expect, it, vi } from "vitest";
import { waitForPoll } from "./agent-orchestrator.js";

describe("orchestrator bounds", () => {
  it("keeps configured worker parallelism within the documented ceiling", () => {
    const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= 32;
    expect(valid(1)).toBe(true);
    expect(valid(32)).toBe(true);
    expect(valid(0)).toBe(false);
    expect(valid(33)).toBe(false);
  });
});

describe("poll wait cleanup", () => {
  it("removes the abort listener after the timer resolves", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const waiting = waitForPoll(controller.signal, 50);
      await vi.advanceTimersByTimeAsync(50);
      await waiting;
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timer and removes the listener when aborted", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const waiting = waitForPoll(controller.signal, 5_000);
      controller.abort();
      await waiting;
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not allocate a timer or listener for an already-aborted signal", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      controller.abort();
      const addListener = vi.spyOn(controller.signal, "addEventListener");
      await waitForPoll(controller.signal, 5_000);
      expect(addListener).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
