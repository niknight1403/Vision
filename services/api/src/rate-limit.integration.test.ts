import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./app.js";
import { hashPassword } from "./auth-session-service.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!databaseEnabled);
const SIGNING_SECRET = "test-signing-secret-with-at-least-32-characters";
const PASSWORD = "correct horse battery staple";

const prisma = new PrismaClient();
const createdUserIds: string[] = [];
const apps: FastifyInstance[] = [];

/** Each test gets its own limiter state, so one test cannot exhaust another's budget. */
async function buildApp(rateLimits: {
  auth: { maxHits: number; windowMs: number; maxKeys: number };
  scan: { maxHits: number; windowMs: number; maxKeys: number };
  analysis: { maxHits: number; windowMs: number; maxKeys: number };
}) {
  const instance = await buildServer({ prisma, authSigningSecret: SIGNING_SECRET, rateLimits });
  await instance.ready();
  apps.push(instance);
  return instance;
}

async function createUser() {
  const email = `rate-limit-${process.pid}-${Date.now()}@example.test`;
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD), role: "ADMIN" },
  });
  createdUserIds.push(user.id);
  return email;
}

suite("rate limiting on sensitive routes", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.refreshSession.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    for (const instance of apps) await instance.close();
    await prisma.$disconnect();
  });

  it("refuses a second login attempt with 429, Retry-After and a remaining header", async () => {
    const app = await buildApp({
      auth: { maxHits: 1, windowMs: 60_000, maxKeys: 100 },
      scan: { maxHits: 1, windowMs: 60_000, maxKeys: 100 },
      analysis: { maxHits: 1, windowMs: 60_000, maxKeys: 100 },
    });
    const email = await createUser();
    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-ratelimit-remaining"]).toBe("0");

    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: "RATE_LIMIT_EXCEEDED", retryAfterSeconds: 60 });
    expect(second.headers["retry-after"]).toBe("60");
  });

  it("limits an authenticated route per principal, not per token", async () => {
    const app = await buildApp({
      auth: { maxHits: 10, windowMs: 60_000, maxKeys: 100 },
      scan: { maxHits: 1, windowMs: 60_000, maxKeys: 100 },
      analysis: { maxHits: 1, windowMs: 60_000, maxKeys: 100 },
    });
    const email = await createUser();
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const token = (login.json() as { accessToken: string }).accessToken;
    const headers = { authorization: "Bearer " + token };

    const firstScan = await app.inject({
      method: "POST", url: "/v1/deals/scan", headers,
      payload: { query: "vinyl", limit: 1, currency: "EUR" },
    });
    expect(firstScan.statusCode).not.toBe(429);

    const secondScan = await app.inject({
      method: "POST", url: "/v1/deals/scan", headers,
      payload: { query: "vinyl", limit: 1, currency: "EUR" },
    });
    expect(secondScan.statusCode).toBe(429);
    expect(secondScan.json().error).toBe("RATE_LIMIT_EXCEEDED");
  });
});
