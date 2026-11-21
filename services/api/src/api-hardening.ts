export function redactSensitive(value: string): string {
  return value.replace(/(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").replace(/https?:\/\/[^\s]+/gi, "[URL_REDACTED]");
}
export class InProcessRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly maxHits: number, private readonly windowMs: number) {
    if (!Number.isInteger(maxHits) || maxHits < 1 || !Number.isInteger(windowMs) || windowMs < 1000) throw new Error("RATE_LIMIT_CONFIG_INVALID");
  }
  allow(key: string, now = Date.now()): boolean {
    const current = (this.hits.get(key) ?? []).filter((stamp) => stamp > now - this.windowMs);
    if (current.length >= this.maxHits) { this.hits.set(key, current); return false; }
    current.push(now); this.hits.set(key, current); return true;
  }
}
