/** Exponential backoff with bounded jitter and a hard cap. */

export interface BackoffOptions {
  /** Delay of the first retry (attempt 1). */
  initialDelayMs: number;
  /** Never wait longer than this, including jitter. */
  maxDelayMs: number;
  /** Growth per attempt; 2 means 1s, 2s, 4s, 8s … */
  factor: number;
  /** 0.2 means the delay lands within ±20% of the exponential value. */
  jitterRatio: number;
  /** Injectable randomness in [0, 1). */
  random: () => number;
}

export const DEFAULT_BACKOFF: Omit<BackoffOptions, "random"> = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2,
  jitterRatio: 0.2,
};

/**
 * @param attempt 1-based attempt counter (attempt 1 is the first retry wait).
 * @returns delay in milliseconds, always within
 *          `[min(cap, exp) * (1 - jitter), min(cap, exp) * (1 + jitter)]`
 *          and never above `maxDelayMs`.
 */
export function computeBackoffDelay(attempt: number, options: BackoffOptions): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const { initialDelayMs, maxDelayMs, factor, jitterRatio, random } = options;
  const exponential = initialDelayMs * Math.pow(factor, safeAttempt - 1);
  const capped = Math.min(maxDelayMs, exponential);
  const ratio = Math.min(0.9, Math.max(0, jitterRatio));
  const sample = Math.min(1, Math.max(0, random()));
  const jittered = capped * (1 - ratio + 2 * ratio * sample);
  return Math.max(0, Math.min(maxDelayMs, Math.round(jittered)));
}

/** Deterministic part of the backoff (before jitter), exposed for tests/UI. */
export function computeBackoffBase(attempt: number, options: Omit<BackoffOptions, "random" | "jitterRatio">): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(options.maxDelayMs, options.initialDelayMs * Math.pow(options.factor, safeAttempt - 1));
}
