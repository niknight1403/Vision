export function redactSensitive(value: string): string {
  return value.replace(/(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").replace(/https?:\/\/[^\s]+/gi, "[URL_REDACTED]");
}

export type RateLimitDecision = {
  /** True when this request may proceed. */
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Milliseconds until the oldest counted hit leaves the window. */
  retryAfterMs: number;
};

export type RateLimitConfig = {
  maxHits: number;
  windowMs: number;
  maxKeys: number;
};

const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 86_400_000;
const MAX_KEYS_CEILING = 1_000_000;

function readBoundedInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error("RATE_LIMIT_CONFIG_INVALID");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("RATE_LIMIT_CONFIG_INVALID");
  }
  void name;
  return value;
}

/**
 * Read a limiter configuration from the environment.
 *
 * Every value is bounded, so a typo cannot silently disable the limit or make a
 * window so large that one hit blocks a principal for hours. Invalid input throws
 * instead of falling back to an insecure default.
 */
export function rateLimitConfigFromEnv(
  env: Record<string, string | undefined>,
  names: { max: string; window: string },
  defaults: { maxHits: number; windowMs: number },
): RateLimitConfig {
  return {
    maxHits: readBoundedInteger(env[names.max], defaults.maxHits, names.max, 1, 100_000),
    windowMs: readBoundedInteger(env[names.window], defaults.windowMs, names.window, MIN_WINDOW_MS, MAX_WINDOW_MS),
    maxKeys: readBoundedInteger(env.RATE_LIMIT_MAX_KEYS, 10_000, "RATE_LIMIT_MAX_KEYS", 1, MAX_KEYS_CEILING),
  };
}

/**
 * Sliding-window limiter with a hard bound on tracked keys.
 *
 * The previous implementation kept every key forever, so an attacker could grow
 * the map without limit, and it exposed only a boolean, which made a correct
 * `Retry-After` impossible. This version expires hits, reports the wait, and
 * evicts the least recently used key once `maxKeys` is reached.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxHits: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(maxHits: number, windowMs: number, maxKeys = 10_000) {
    if (!Number.isInteger(maxHits) || maxHits < 1) throw new Error("RATE_LIMIT_CONFIG_INVALID");
    if (!Number.isInteger(windowMs) || windowMs < MIN_WINDOW_MS || windowMs > MAX_WINDOW_MS) {
      throw new Error("RATE_LIMIT_CONFIG_INVALID");
    }
    if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > MAX_KEYS_CEILING) {
      throw new Error("RATE_LIMIT_CONFIG_INVALID");
    }
    this.maxHits = maxHits;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  /** Number of principals currently tracked; bounded by `maxKeys`. */
  get trackedKeys(): number {
    return this.hits.size;
  }

  check(key: string, now = Date.now()): RateLimitDecision {
    const windowStart = now - this.windowMs;
    const previous = this.hits.get(key) ?? [];
    const current = previous.filter((stamp) => stamp > windowStart);
    // Re-insert so the map's insertion order tracks recent use for eviction.
    this.hits.delete(key);
    if (current.length >= this.maxHits) {
      this.hits.set(key, current);
      const oldest = current[0] ?? now;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, oldest + this.windowMs - now),
      };
    }
    current.push(now);
    this.hits.set(key, current);
    this.evict(now);
    return { allowed: true, remaining: this.maxHits - current.length, retryAfterMs: 0 };
  }

  allow(key: string, now = Date.now()): boolean {
    return this.check(key, now).allowed;
  }

  private evict(now: number): void {
    if (this.hits.size <= this.maxKeys) return;
    const windowStart = now - this.windowMs;
    for (const [key, stamps] of this.hits) {
      if (this.hits.size <= this.maxKeys) return;
      const newest = stamps[stamps.length - 1];
      if (newest === undefined || newest <= windowStart) this.hits.delete(key);
    }
    while (this.hits.size > this.maxKeys) {
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey === undefined) return;
      this.hits.delete(oldestKey);
    }
  }
}

/** Backwards-compatible alias; the old class never bounded its key map. */
export class InProcessRateLimiter extends SlidingWindowRateLimiter {}

/** Seconds for a `Retry-After` header, never zero. */
export function retryAfterSeconds(decision: RateLimitDecision): number {
  return Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
}
