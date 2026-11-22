import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./app.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!databaseEnabled);
const METRICS_TOKEN = "metrics-token-with-at-least-16-chars";

const prisma = new PrismaClient();
const apps: FastifyInstance[] = [];

async function buildApp(metricsToken?: string) {
  const instance = await buildServer({ prisma, metricsToken });
  await instance.ready();
  apps.push(instance);
  return instance;
}

suite("observability", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const instance of apps) await instance.close();
    await prisma.$disconnect();
  });

  it("keeps /metrics closed when no token is configured", async () => {
    const app = await buildApp(undefined);
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("METRICS_NOT_CONFIGURED");
  });

  it("requires the metrics bearer token", async () => {
    const app = await buildApp(METRICS_TOKEN);
    const anonymous = await app.inject({ method: "GET", url: "/metrics" });
    expect(anonymous.statusCode).toBe(401);
    const wrong = await app.inject({
      method: "GET", url: "/metrics", headers: { authorization: "Bearer wrong-token-wrong-token" },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("counts requests per route template and exports outbox gauges", async () => {
    const app = await buildApp(METRICS_TOKEN);
    await app.inject({ method: "GET", url: "/livez" });
    await app.inject({ method: "GET", url: "/livez" });
    await app.inject({ method: "GET", url: "/v1/deals" }); // 401, still counted

    const response = await app.inject({
      method: "GET", url: "/metrics", headers: { authorization: "Bearer " + METRICS_TOKEN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    const body = response.body;
    expect(body).toContain('http_requests_total{method="GET",route="/livez",status="200"} 2');
    // The route is closed without a signing secret, so the status is 503; what
    // matters here is that the template, not the raw URL, is the label.
    expect(body).toMatch(/http_requests_total\{method="GET",route="\/v1\/deals",status="\d{3}"\} 1/);
    expect(body).toContain("# TYPE outbox_events gauge");
    expect(body).toContain('outbox_events{status="DEAD_LETTER"}');
    expect(body).toContain("# TYPE agent_tasks gauge");
    // No raw URL or query string may leak into a label.
    expect(body).not.toContain("authorization");
  });

  it("echoes the correlation id on every response", async () => {
    const app = await buildApp(METRICS_TOKEN);
    const supplied = await app.inject({
      method: "GET", url: "/livez", headers: { "x-request-id": "corr-abcdefgh" },
    });
    expect(supplied.headers["x-request-id"]).toBe("corr-abcdefgh");
    const generated = await app.inject({ method: "GET", url: "/livez" });
    expect(String(generated.headers["x-request-id"]).length).toBeGreaterThan(0);
  });
});
