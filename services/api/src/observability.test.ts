import { describe, expect, it } from "vitest";
import { createMetrics, MetricsRegistry } from "./observability.js";

describe("metrics registry", () => {
  it("renders counters and gauges in the prometheus text format", () => {
    const metrics = new MetricsRegistry();
    metrics.describe("http_requests_total", "HTTP requests");
    metrics.increment("http_requests_total", { route: "/health", method: "GET", status: "200" });
    metrics.increment("http_requests_total", { route: "/health", method: "GET", status: "200" });
    metrics.setGauge("http_requests_in_flight", {}, 3);

    const rendered = metrics.render();
    expect(rendered).toContain("# HELP http_requests_total HTTP requests");
    expect(rendered).toContain("# TYPE http_requests_total counter");
    expect(rendered).toContain('http_requests_total{method="GET",route="/health",status="200"} 2');
    expect(rendered).toContain("# TYPE http_requests_in_flight gauge");
    expect(rendered).toContain("http_requests_in_flight 3");
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it("escapes label values and keeps output order stable", () => {
    const metrics = new MetricsRegistry();
    metrics.increment("http_requests_total", { route: '/a"b\\c' });
    metrics.increment("http_requests_total", { route: "/a" });
    const first = metrics.render();
    expect(first).toContain('route="/a\\"b\\\\c"');
    expect(first).toBe(metrics.render());
  });

  it("replaces gauges instead of accumulating them", () => {
    const metrics = new MetricsRegistry();
    metrics.setGauge("outbox_events", { status: "PENDING" }, 5);
    metrics.setGauge("outbox_events", { status: "PENDING" }, 2);
    expect(metrics.render()).toContain('outbox_events{status="PENDING"} 2');
  });

  it("rejects an invalid metric name and a negative counter increment", () => {
    const metrics = new MetricsRegistry();
    expect(() => metrics.increment("Bad-Name")).toThrow("METRIC_NAME_INVALID");
    expect(() => metrics.increment("ok_name", {}, -1)).toThrow("METRIC_VALUE_INVALID");
  });

  it("bounds the number of series", () => {
    const metrics = new MetricsRegistry();
    for (let index = 0; index < 5_000; index += 1) metrics.increment("http_requests_total", { route: "/r" + index });
    expect(() => metrics.increment("http_requests_total", { route: "/overflow" })).toThrow("METRIC_SERIES_LIMIT_REACHED");
  });

  it("pre-registers the documented families", () => {
    const rendered = createMetrics().render();
    expect(rendered).toBe("");
    const metrics = createMetrics();
    metrics.increment("http_requests_total");
    expect(metrics.render()).toContain("# HELP http_requests_total");
  });
});
