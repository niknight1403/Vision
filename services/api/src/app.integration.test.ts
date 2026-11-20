import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
const createdDealIds: string[] = [];
const createdTaskIds: string[] = [];
const createdTenantIds: string[] = [];
const tenantByEmail = new Map<string, string>();
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
  const tenant = await prisma.tenant.create({ data: { name: "Test workspace" } });
  createdTenantIds.push(tenant.id);
  await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: role === "ADMIN" ? "OWNER" : "VIEWER" } });
  tenantByEmail.set(email, tenant.id);
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

function tenantHeader(email: string) { return { "x-tenant-id": tenantByEmail.get(email)! }; }

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
    app = await buildServer({ prisma, authSigningSecret: SIGNING_SECRET });
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
    await prisma.dealReview.deleteMany({ where: { candidateId: { in: createdDealIds } } });
    await prisma.dealCandidate.deleteMany({ where: { id: { in: createdDealIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
    createdUserIds.length = 0;
    createdTenantIds.length = 0;
    tenantByEmail.clear();
    createdDealIds.length = 0;
    createdTaskIds.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  it("rejects a wrong password without issuing a session", async () => {
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
    const headers = { authorization: "Bearer " + tokens.accessToken, ...tenantHeader(adminEmail), "x-idempotency-key": key };
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
      headers: { authorization: "Bearer " + tokens.accessToken, ...tenantHeader(adminEmail) } });
    expect(status.statusCode).toBe(200);
    expect(status.json().status).toBe("QUEUED");
    expect(status.json().result).toBeNull();
  });

  it("rejects reuse of a treasure-analysis idempotency key with different input", async () => {
    const deal = await createDeal();
    const tokens = await login(adminEmail);
    const headers = { authorization: "Bearer " + tokens.accessToken, ...tenantHeader(adminEmail),
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
      headers: { authorization: `Bearer ${viewer.accessToken}`, ...tenantHeader(viewerEmail) },
      payload: { imageUrl: "https://images.example.test/item.jpg" },
    });
    expect(forbidden.statusCode).toBe(403);

    const admin = await login(adminEmail);
    const unavailable = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/vision-inspection`,
      headers: { authorization: `Bearer ${admin.accessToken}`, ...tenantHeader(adminEmail) },
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
      headers: { authorization: `Bearer ${accessToken}`, ...tenantHeader(viewerEmail) },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { deals: Array<Record<string, unknown>> };
    const listed = body.deals.find((entry) => entry.id === deal.id);
    expect(listed).toBeDefined();
    expect(listed?.purchasePriceMinor).toBe("12345");
    expect(listed?.expectedProfitCents).toBe("2500");
  });

  it("rejects a tenant selector that belongs to another user", async () => {
    const { accessToken } = await login(viewerEmail);
    const response = await app.inject({
      method: "GET",
      url: "/v1/deals",
      headers: { authorization: `Bearer ${accessToken}`, ...tenantHeader(adminEmail) },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "TENANT_ACCESS_DENIED" });
  });

  it("lists only the authenticated user's tenant memberships", async () => {
    const { accessToken } = await login(viewerEmail);
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tenants).toEqual([
      { id: tenantByEmail.get(viewerEmail), name: "Test workspace", role: "VIEWER" },
    ]);
  });

  it("forbids a viewer from reviewing a deal", async () => {
    const deal = await createDeal();
    const { accessToken } = await login(viewerEmail);
    const response = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/review`,
      headers: { authorization: `Bearer ${accessToken}`, ...tenantHeader(viewerEmail) },
      payload: { decision: "APPROVED" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "TENANT_ADMIN_ROLE_REQUIRED" });
    expect(await prisma.dealReview.count({ where: { candidateId: deal.id } })).toBe(0);
  });

  it("allows a tenant admin to update the review in its own tenant", async () => {
    const deal = await createDeal();
    const { accessToken } = await login(adminEmail);
    const first = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/review`,
      headers: { authorization: `Bearer ${accessToken}`, ...tenantHeader(adminEmail) },
      payload: { decision: "APPROVED" },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { review: { decision: string; reviewerUserId: string } };
    expect(body.review.decision).toBe("APPROVED");
    expect(body.review.reviewerUserId).toEqual(expect.any(String));

    const second = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/review`,
      headers: { authorization: `Bearer ${accessToken}`, ...tenantHeader(adminEmail) },
      payload: { decision: "REJECTED" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().review.decision).toBe("REJECTED");
    expect(await prisma.dealReview.count({ where: { tenantId: tenantByEmail.get(adminEmail), candidateId: deal.id } })).toBe(1);
  });

  it("keeps one tenant's deal review invisible to another tenant", async () => {
    const deal = await createDeal();
    const admin = await login(adminEmail);
    const approved = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/review`,
      headers: { authorization: `Bearer ${admin.accessToken}`, ...tenantHeader(adminEmail) },
      payload: { decision: "APPROVED" },
    });
    expect(approved.statusCode).toBe(200);

    const viewer = await login(viewerEmail);
    const listed = await app.inject({
      method: "GET",
      url: "/v1/deals?limit=100",
      headers: { authorization: `Bearer ${viewer.accessToken}`, ...tenantHeader(viewerEmail) },
    });
    expect(listed.statusCode).toBe(200);
    const otherTenantDeal = (listed.json() as { deals: Array<{ id: string; reviewStatus: string }> })
      .deals.find((entry) => entry.id === deal.id);
    expect(otherTenantDeal?.reviewStatus).toBe("DISCOVERED");

    const sharedCandidate = await prisma.dealCandidate.findUniqueOrThrow({ where: { id: deal.id } });
    expect(sharedCandidate.reviewStatus).toBe("DISCOVERED");
    expect(sharedCandidate.reviewedBy).toBeNull();
  });

  it("refuses to approve a simulated or risk-rejected candidate", async () => {
    const deal = await createDeal({ simulated: true });
    const { accessToken } = await login(adminEmail);
    const response = await app.inject({
      method: "POST",
      url: `/v1/deals/${deal.id}/review`,
      headers: { authorization: `Bearer ${accessToken}`, ...tenantHeader(adminEmail) },
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
      headers: { authorization: `Bearer ${accessToken}`, ...tenantHeader(adminEmail) },
      payload: { decision: "PUBLISHED" },
    });
    expect(invalidDecision.statusCode).toBe(400);
    expect(invalidDecision.json()).toEqual({ error: "DEAL_REVIEW_DECISION_INVALID" });

    const missing = await app.inject({
      method: "POST",
      url: "/v1/deals/does-not-exist/review",
      headers: { authorization: `Bearer ${accessToken}`, ...tenantHeader(adminEmail) },
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
