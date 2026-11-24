export type RouteCost = "FREE" | "PAID" | "UNKNOWN";
export interface FreeRoute<T> {
  id: string;
  cost: RouteCost;
  execute(signal: AbortSignal): Promise<T>;
}
export class RouteFailure extends Error {
  constructor(readonly retryable: boolean, readonly retryAfterMs = 30_000) {
    super("ROUTE_FAILURE");
  }
}
export class FreeRouteRouter {
  private readonly cooldowns = new Map<string, number>();
  constructor(private readonly now = Date.now) {}
  async execute<T>(routes: readonly FreeRoute<T>[], signal: AbortSignal): Promise<{ routeId: string; value: T }> {
    const seen = new Set<string>();
    for (const route of routes) {
      signal.throwIfAborted();
      if (route.cost !== "FREE" || seen.has(route.id)) continue;
      seen.add(route.id);
      if ((this.cooldowns.get(route.id) ?? 0) > this.now()) continue;
      try {
        const value = await route.execute(AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
        signal.throwIfAborted();
        this.cooldowns.delete(route.id);
        return { routeId: route.id, value };
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof RouteFailure && !error.retryable) throw error;
        const delay = error instanceof RouteFailure ? error.retryAfterMs : 30_000;
        this.cooldowns.set(route.id, this.now() + (Number.isFinite(delay) ? Math.max(1000, Math.min(delay, 3600000)) : 30000));
      }
    }
    signal.throwIfAborted();
    throw new Error("NO_FREE_ROUTE_AVAILABLE");
  }
}
