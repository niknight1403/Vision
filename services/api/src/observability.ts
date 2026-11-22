/**
 * Minimal, dependency-free metrics registry with a Prometheus text rendering.
 *
 * The API previously exposed only health endpoints, so an operator could see
 * whether the process was up but not how it behaved: no request counts, no error
 * rate, no latency. This registry keeps cardinality bounded by construction
 * (route templates, never raw URLs) and renders the Prometheus text format.
 */
export type MetricLabels = Record<string, string>;

const NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const MAX_SERIES = 5_000;

function seriesKey(name: string, labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return name + "|" + entries.map(([key, value]) => `${key}=${value}`).join(",");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return "{" + entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",") + "}";
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) throw new Error("METRIC_NAME_INVALID");
}

export class MetricsRegistry {
  private readonly counters = new Map<string, { name: string; labels: MetricLabels; value: number }>();
  private readonly gauges = new Map<string, { name: string; labels: MetricLabels; value: number }>();
  private readonly help = new Map<string, string>();

  describe(name: string, description: string): void {
    assertName(name);
    this.help.set(name, description);
  }

  increment(name: string, labels: MetricLabels = {}, value = 1): void {
    assertName(name);
    if (!Number.isFinite(value) || value < 0) throw new Error("METRIC_VALUE_INVALID");
    const key = seriesKey(name, labels);
    const existing = this.counters.get(key);
    if (!existing && this.counters.size >= MAX_SERIES) throw new Error("METRIC_SERIES_LIMIT_REACHED");
    this.counters.set(key, { name, labels, value: (existing?.value ?? 0) + value });
  }

  setGauge(name: string, labels: MetricLabels, value: number): void {
    assertName(name);
    if (!Number.isFinite(value)) throw new Error("METRIC_VALUE_INVALID");
    const key = seriesKey(name, labels);
    const existing = this.gauges.get(key);
    if (!existing && this.gauges.size >= MAX_SERIES) throw new Error("METRIC_SERIES_LIMIT_REACHED");
    this.gauges.set(key, { name, labels, value });
  }

  /** Prometheus text format; families are grouped and series sorted for stable diffs. */
  render(): string {
    const families = new Map<string, { type: "counter" | "gauge"; series: string[] }>();
    const push = (type: "counter" | "gauge", entry: { name: string; labels: MetricLabels; value: number }) => {
      const family = families.get(entry.name) ?? { type, series: [] };
      family.series.push(`${entry.name}${renderLabels(entry.labels)} ${entry.value}`);
      families.set(entry.name, family);
    };
    for (const entry of this.counters.values()) push("counter", entry);
    for (const entry of this.gauges.values()) push("gauge", entry);

    const lines: string[] = [];
    for (const name of [...families.keys()].sort()) {
      const family = families.get(name)!;
      const description = this.help.get(name);
      if (description) lines.push(`# HELP ${name} ${description}`);
      lines.push(`# TYPE ${name} ${family.type}`);
      lines.push(...family.series.sort());
    }
    return lines.length === 0 ? "" : lines.join("\n") + "\n";
  }
}

export function createMetrics(): MetricsRegistry {
  const metrics = new MetricsRegistry();
  metrics.describe("http_requests_total", "HTTP requests by route template, method and status code");
  metrics.describe("http_request_duration_ms_total", "Cumulative request duration in milliseconds by route template");
  metrics.describe("http_requests_in_flight", "Requests currently being handled");
  metrics.describe("outbox_events", "Outbox events by status");
  metrics.describe("agent_tasks", "Agent tasks by status");
  return metrics;
}
