import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./app.js";
import { hashPassword } from "./auth-session-service.js";
import { ProviderRegistry } from "./providers/registry.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!databaseEnabled);
const SIGNING_SECRET = "test-signing-secret-with-at-least-32-characters";
const PASSWORD = "correct horse battery staple";

const prisma = new PrismaClient();
const createdUserIds: string[] = [];
const createdDealIds: string[] = [];
const createdTaskIds: string[] = [];
let app: FastifyInstance;
let adminEmail: string;
let viewerEmail: string;
let sequence = 0;

async function createUser(role: "ADMIN" | "VIEWER") {
  sequence += 1;
  const email = `route-rbac-${process.pid}-${sequence}@example.test`;
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD), role },
  });
  createdUserIds.push(user.id);
  return email;
}

async function createDeal(overrides: { simulated?: boolean; riskPassed?: boolean } = {}) {
  sequence += 1;
  const deal = await prisma.dealCandidate.create({
    data: {
      providerId: "test-provider",
      externalId: `route-rbac-deal-${process.pid}-${sequence}`,
      title: "Test deal",
      productUrl: "https://example.test/product",
      currency: "EUR",
      purchasePriceMinor: 12_345n,
      observedAt: new Date(),
      simulated: overrides.simulated ?? false,
      totalCostCents: 14_000n,
      expectedProfitCents: 2_500n,
      roiBasisPoints: 1_785n,
      riskPassed: overrides.riskPassed ?? true,
      riskReasons: [],
    },
  });
  createdDealIds.push(deal.id);
  return deal;
}

async function login(email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { accessToken: string; refreshToken: string };
}

suite("authenticated deal review routes (RBAC)", () => {
  beforeAll(async () => {
    await prisma.$connect();
    const providers = new ProviderRegistry();
    providers.register({
      providerId: "test-market",
      displayName: "Integration test marketplace",
      capabilities: ["PRODUCT_SEARCH"],
      simulated: false,
      healthCheck: async () => ({ status: "HEALTHY", checkedAt: new Date().toISOString() }),
      searchProducts: async ({ query, limit, currency }) => [{
        providerId: "test-market",
        externalId: "scan-" + query.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        title: "Live provider result " + query,
        url: "https://market.example.test/item/scan",
        currency,
        priceMinor: 5_000,
        observedAt: new Date().toISOString(),
        simulated: false,
      }].slice(0, limit),
    });
    app = await buildServer({ prisma, authSigningSecret: SIGNING_SECRET, providers });
    await app.ready();
  });

  beforeEach(async () => {
    adminEmail = await createUser("ADMIN");
    viewerEmail = await createUser("VIEWER");
  });

  afterEach(async () => {
    await prisma.refreshSession.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: createdTaskIds } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: createdTaskIds } } });
    await prisma.dealCandidate.deleteMany({ where: { id: { in: createdDealIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
    createdDealIds.length = 0;
    createdTaskIds.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });


  it("runs a real provider adapter only for ADMIN and persists its returned product", async () => {
    const viewer = await login(viewerEmail);
    const payload = {
      providerId: "test-market",
      query: "camera",
      limit: 5,
      currency: "EUR",
      costs: {
        inboundShippingCents: "500",
        outboundShippingCents: "500",
        marketplaceFeeCents: "500",
        paymentFeeCents: "100",
        packagingCents: "100",
        riskReserveCents: "100",
      },
      context: {
        resalePriceCents: "12000",
        openTrades: 0,
        dailyLossCents: "0",
        riskLimits: {
          maxTradeCents: "20000",
          maxOpenTrades: 5,
          maxDailyLossCents: "50000",
          minProfitCents: "1000",
          minRoiBasisPoints: "1000",
        },
      },
    };
    const forbidden = await app.inject({
      method: "POST", url: "/v1/deals/scan",
      headers: { authorization: "Bearer " + viewer.accessToken }, payload,
    });
    expect(forbidden.statusCode).toBe(403);

    const admin = await login(adminEmail);
    const response = await app.inject({
      method: "POST", url: "/v1/deals/scan",
      headers: { authorization: "Bearer " + admin.accessToken }, payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providerId: "test-market",
      scannedCount: 1,
      persistedCount: 1,
      simulatedCount: 0,
      purchaseAuthorized: false,
      profitMeaning: "ESTIMATE_NOT_REALIZED",
    });
    const saved = await prisma.dealCandidate.findFirstOrThrow({
      where: { providerId: "test-market", externalId: "scan-camera" },
    });
    createdDealIds.push(saved.id);
    expect(saved.title).toBe("Live provider result camera");
    expect(saved.simulated).toBe(false);
    expect(saved.expectedProfitCents).toBe(5_200n);
  });

  it("does not run a scan when provider credentials are not configured", async () => {
    const admin = await login(adminEmail);
    const response = await app.inject({
      method: "POST", url: "/v1/deals/scan",
      headers: { authorization: "Bearer " + admin.accessToken },
      payload: { providerId: "missing-market", query: "camera" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "DEAL_SCAN_PROVIDER_NOT_FOUND" });
  });
\n  it("rejects a wrong password without issuing a session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: adminEmail, password: "wrong password value" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "INVALID_CREDENTIALS" });
    expect(await prisma.refreshSession.count({ where: { userId: { in: createdUserIds } } })).toBe(0);
  });

  it("keeps the deal list closed without a bearer token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/deals" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "AUTHENTICATION_REQUIRED" });
  });

  it("durably queues an ADMIN treasure analysis with idempotency and exposes task status", async () => {
    const deal = await createDeal();
    const tokens = await login(adminEmail);
    const key = "treasure-test-" + process.pid + "-" + sequence;
    const headers = { authorization: "Bearer " + tokens.accessToken, "x-idempotency-key": key };
    const url = "/v1/deals/" + deal.id + "/treasure-analysis";
    const payload = { imageUrl: "https://images.example.test/item.jpg" };
    const first = await app.inject({ method: "POST", url, headers, payload });
    expect(first.statusCode).toBe(202);
    const queued = first.json() as { taskId: string; status: string; execution: string };
    expect(queued.status).toBe("QUEUED");
    expect(queued.execution).toBe("PENDING_WORKER");
    createdTaskIds.push(queued.taskId);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: queued.taskId } })).toBe(1);
    const repeated = await app.inject({ method: "POST", url, headers, payload });
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json().taskId).toBe(queued.taskId);
    const status = await app.inject({ method: "GET", url: "/v1/treasure-analyses/" + queued.taskId,
      headers: { authorization: "Bearer " + tokens.accessToken } });
    expect(status.statusCode).toBe(200);
    expect(status.json().status).toBe("QUEUED");
    expect(status.json().result).toBeNull();
  });

  it("rejects reuse of a treasure-analysis idempotency key with different input", async () => {
    const deal = await createDeal();
    const tokens = await login(adminEmail);
    const headers = { authorization: "Bearer " + tokens.accessToken,
      "x-idempotency-key": "treasure-conflict-" + process.pid + "-" + sequence };
    const url = "/v1/deals/" + deal.id + "/treasure-analysis";
    const first = await app.inject({ method: "POST", url, headers,
      payload: { imageUrl: "https://images.example.test/one.jpg" } });
    expect(first.statusCode).toBe(202);
    createdTaskIds.push(first.json().taskId);
    const second = await app.inject({ method: "POST", url, headers,
      payload: { imageUrl: "https://images.example.test/two.jpg" } });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "TREASURE_ANALYSIS_IDEMPOTENCY_CONFLICT" });
  });
  it("keeps vision inspection ADMIN-only and unavailable until a worker adapter is configured", async () => {
    const deal = await createDeal();
    const unauthenticated = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/vision-inspection`,
      payload: { imageUrl: "https://images.example.test/item.jpg" },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const viewer = await login(viewerEmail);
    const forbidden = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/vision-inspection`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
      payload: { imageUrl: "https://images.example.test/item.jpg" },
    });
    expect(forbidden.statusCode).toBe(403);

    const admin = await login(adminEmail);
    const unavailable = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/vision-inspection`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { imageUrl: "https://images.example.test/item.jpg" },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: "VISION_INSPECTOR_NOT_CONFIGURED" });
  });

  it("serves the deal list to an authenticated viewer with JSON-safe amounts", async () => {
    const deal = await createDeal();
    const { accessToken } = await login(viewerEmail);
    const response = await app.inject({
      method: "GET",
      url: "/v1/deals?limit=5",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { deals: Array<Record<string, unknown>> };
    const listed = body.deals.find((entry) => entry.id === deal.id);
    expect(listed).toBeDefined();
    expect(listed?.purchasePriceMinor).toBe("12345");
    expect(listed?.expectedProfitCents).toBe("2500");
  });

  it("forbids a viewer from reviewing a deal", async () => {
    const deal = await createDeal();
    const { accessToken } = await login(viewerEmail);
    const response = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/review`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { decision: "APPROVED" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "ADMIN_ROLE_REQUIRED" });
    const unchanged = await prisma.dealCandidate.findUniqueOrThrow({ where: { id: deal.id } });
    expect(unchanged.reviewStatus).toBe("DISCOVERED");
  });

  it("lets an admin approve once and rejects the repeated decision", async () => {
    const deal = await createDeal();
    const { accessToken } = await login(adminEmail);
    const first = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/review`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { decision: "APPROVED" },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { deal: { reviewStatus: string; reviewedBy: string | null } };
    expect(body.deal.reviewStatus).toBe("APPROVED");
    expect(body.deal.reviewedBy).toEqual(expect.any(String));

    const second = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/review`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { decision: "REJECTED" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "DEAL_REVIEW_CONFLICT" });
  });

  it("refuses to approve a simulated or risk-rejected candidate", async () => {
    const deal = await createDeal({ simulated: true });
    const { accessToken } = await login(adminEmail);
    const response = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/review`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { decision: "APPROVED" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "DEAL_NOT_ELIGIBLE_FOR_REVIEW_APPROVAL" });
  });

  it("rejects unknown decisions and unknown deals", async () => {
    const deal = await createDeal();
    const { accessToken } = await login(adminEmail);
    const invalidDecision = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/review`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { decision: "PUBLISHED" },
    });
    expect(invalidDecision.statusCode).toBe(400);
    expect(invalidDecision.json()).toEqual({ error: "DEAL_REVIEW_DECISION_INVALID" });

    const missing = await app.inject({
      method: "POST",
      url: "/v1/deals/does-not-exist/review",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { decision: "REJECTED" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "DEAL_CANDIDATE_NOT_FOUND" });
  });

  it("rotates the refresh token exactly once and revokes it on logout", async () => {
    const { refreshToken } = await login(viewerEmail);

    const rotated = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json() as { refreshToken: string };

    const reuse = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toEqual({ error: "INVALID_REFRESH_TOKEN" });

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      payload: { refreshToken: next.refreshToken },
    });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: next.refreshToken },
    });
    expect(afterLogout.statusCode).toBe(401);
  });
});
