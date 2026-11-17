export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor() {
    super("Provider circuit is open; request was not sent");
    this.name = "CircuitOpenError";
  }
}

/**
 * In-memory per-process circuit breaker. It protects a single API process;
 * distributed deployments must coordinate provider health separately.
 */
export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 15_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.threshold) || this.threshold < 1) {
      throw new Error("failureThreshold must be a positive integer");
    }
    if (!Number.isFinite(this.cooldownMs) || this.cooldownMs < 0) {
      throw new Error("cooldownMs must be a non-negative number");
    }
  }

  getState(): CircuitState {
    this.refreshState();
    return this.state;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.refreshState();
    if (this.state === "OPEN") throw new CircuitOpenError();
    if (this.state === "HALF_OPEN") {
      if (this.probeInFlight) throw new CircuitOpenError();
      this.probeInFlight = true;
    }

    try {
      const result = await operation();
      this.failures = 0;
      this.state = "CLOSED";
      this.probeInFlight = false;
      return result;
    } catch (error) {
      this.failures += 1;
      this.probeInFlight = false;
      if (this.state === "HALF_OPEN" || this.failures >= this.threshold) {
        this.state = "OPEN";
        this.openedAt = this.now();
      }
      throw error;
    }
  }

  private refreshState(): void {
    if (
      this.state === "OPEN" &&
      this.now() - this.openedAt >= this.cooldownMs
    ) {
      this.state = "HALF_OPEN";
    }
  }
}
