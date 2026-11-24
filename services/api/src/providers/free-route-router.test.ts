import { describe, it, expect, vi } from "vitest";
import { FreeRouteRouter, RouteFailure } from "./free-route-router.js";

describe("FreeRouteRouter", () => {
  it("never executes paid or unknown routes", async () => {
    const execute = vi.fn(async () => "unexpected");
    await expect(new FreeRouteRouter().execute([
      { id: "paid", cost: "PAID", execute },
      { id: "unknown", cost: "UNKNOWN", execute },
    ], new AbortController().signal)).rejects.toThrow("NO_FREE_ROUTE_AVAILABLE");
    expect(execute).not.toHaveBeenCalled();
  });
  it("falls back and respects cooldown", async () => {
    let now = 0;
    const router = new FreeRouteRouter(() => now);
    const execute = vi.fn(async () => { throw new RouteFailure(true, 2000); });
    const routes = [
      { id: "first", cost: "FREE" as const, execute },
      { id: "second", cost: "FREE" as const, execute: async () => "ok" },
    ];
    const signal = new AbortController().signal;
    expect(await router.execute(routes, signal)).toEqual({ routeId: "second", value: "ok" });
    await router.execute(routes, signal);
    expect(execute).toHaveBeenCalledTimes(1);
    now = 2001;
    await router.execute(routes, signal);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("does not execute routes after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => "unexpected");
    await expect(new FreeRouteRouter().execute([{ id: "free", cost: "FREE", execute }], controller.signal)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
