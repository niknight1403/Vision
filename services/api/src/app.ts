import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import type { DealCandidate, PrismaClient } from "@prisma/client";
import { config } from "./config.js";
import { authenticateBearerToken, requireAdmin, type AuthenticatedPrincipal } from "./auth-service.js";
import { loginWithPassword, revokeRefreshToken, rotateRefreshToken } from "./auth-session-service.js";
import { listDealCandidates, reviewDealCandidate } from "./deal-candidate-service.js";
import type { ProviderListingRecord, ProviderListingStore } from "./listing-service.js";
import type { ProviderRegistry } from "./providers/registry.js";

export interface ServerDependencies {
  prisma: PrismaClient;
  /** HS256 signing secret for access tokens; unset means the auth routes stay closed. */
  authSigningSecret?: string | undefined;
  now?: () => Date;
  /** Optional allowlist-enforcing vision worker adapter; absent means inspection stays unavailable. */
  visionInspector?: {
    inspectItemVisuals(imageUrl: string, hintTitle: string): Promise<Record<string, unknown>>;
  };
  listingStore?: ProviderListingStore;
  providers?: ProviderRegistry;
}

type ReviewDecision = "APPROVED" | "REJECTED" | "ARCHIVED";

const REVIEW_DECISIONS: readonly ReviewDecision[] = ["APPROVED", "REJECTED", "ARCHIVED"];
const REVIEW_STATUSES = ["DISCOVERED", "APPROVED", "REJECTED", "ARCHIVED"] as const;
const MAX_DEAL_LIMIT = 100;

const STATUS_BY_ERROR: Readonly<Record<string, number>> = Object.freeze({
  AUTH_SIGNING_SECRET_NOT_CONFIGURED: 503,
  AUTHENTICATION_REQUIRED: 401,
  AUTH_TOKEN_INVALID: 401,
  AUTH_TOKEN_EXPIRED_OR_NOT_ACTIVE: 401,
  AUTHENTICATED_USER_UNAVAILABLE: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_REFRESH_TOKEN: 401,
  REFRESH_TOKEN_REUSE_OR_RACE: 401,
  ADMIN_ROLE_REQUIRED: 403,
  PASSWORD_POLICY_VIOLATION: 400,
  DEAL_CANDIDATE_NOT_FOUND: 404,
  DEAL_REVIEW_CONFLICT: 409,
  DEAL_NOT_ELIGIBLE_FOR_REVIEW_APPROVAL: 422,
  DEAL_REVIEW_FIELDS_REQUIRED: 400,
  DEAL_LIST_LIMIT_INVALID: 400,
  VISION_INSPECTOR_NOT_CONFIGURED: 503,
  VISION_WORKER_UNAVAILABLE: 502,
  VISION_WORKER_TIMEOUT: 504,
  VISION_WORKER_REJECTED: 502,
  VISION_WORKER_RESPONSE_INVALID: 502,
  VISION_IMAGE_URL_REQUIRED: 400,
  LISTING_STORAGE_NOT_CONFIGURED: 503,
  LISTING_LIMIT_INVALID: 400,
  LISTING_QUERY_INVALID: 400,
  LISTING_SEARCH_LIMIT_INVALID: 400,
  EBAY_API_NOT_CONFIGURED: 503,
  EBAY_RATE_LIMITED: 429,
  EBAY_API_UNAVAILABLE: 502,
  EBAY_SEARCH_FAILED: 502,
  EBAY_RESPONSE_INVALID: 502,
  EBAY_OAUTH_FAILED: 502,
  TREASURE_ANALYSIS_IDEMPOTENCY_REQUIRED: 400,
  TREASURE_ANALYSIS_IDEMPOTENCY_CONFLICT: 409,
  TREASURE_ANALYSIS_INPUT_INVALID: 400,
  AGENT_TASK_NOT_FOUND: 404,
});

/** BigInt cents and Date values are normalised so the payload stays JSON-safe. */
function serializeDeal(deal: DealCandidate) {
  return {
    id: deal.id,
    providerId: deal.providerId,
    externalId: deal.externalId,
    title: deal.title,
    productUrl: deal.productUrl,
    currency: deal.currency,
    purchasePriceMinor: deal.purchasePriceMinor.toString(),
    totalCostCents: deal.totalCostCents.toString(),
    expectedProfitCents: deal.expectedProfitCents.toString(),
    roiBasisPoints: deal.roiBasisPoints === null ? null : deal.roiBasisPoints.toString(),
    observedAt: deal.observedAt.toISOString(),
    simulated: deal.simulated,
    riskPassed: deal.riskPassed,
    riskReasons: deal.riskReasons,
    reviewStatus: deal.reviewStatus,
    reviewedBy: deal.reviewedBy,
    reviewedAt: deal.reviewedAt?.toISOString() ?? null,
    createdAt: deal.createdAt.toISOString(),
    updatedAt: deal.updatedAt.toISOString(),
  };
}

function serializeListing(listing: ProviderListingRecord) {
  return {
    id: listing.id,
    providerId: listing.providerId,
    externalId: listing.externalId,
    title: listing.title,
    productUrl: listing.productUrl,
    imageUrl: listing.imageUrl,
    currency: listing.currency,
    priceMinor: listing.priceMinor.toString(),
    observedAt: listing.observedAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
  };
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : "INTERNAL_ERROR";
}

export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const { prisma } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", requestIdHeader: "x-request-id" });

  await app.register(helmet);
  const allowedOrigins = new Set(
    (process.env.API_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  if (process.env.NODE_ENV !== "production") {
    allowedOrigins.add("http://localhost:8081");
    allowedOrigins.add("http://127.0.0.1:8081");
  }
  await app.register(cors, {
    origin(origin, callback) {
      callback(null, origin === undefined || allowedOrigins.has(origin));
    },
  });

  function signingSecret(): string {
    if (!dependencies.authSigningSecret) throw new Error("AUTH_SIGNING_SECRET_NOT_CONFIGURED");
    return dependencies.authSigningSecret;
  }

  function fail(reply: FastifyReply, error: unknown) {
    const code = errorCode(error);
    const status = STATUS_BY_ERROR[code];
    if (status === undefined) {
      reply.log.error({ err: error }, "unhandled route error");
      return reply.code(500).send({ error: "INTERNAL_ERROR" });
    }
    return reply.code(status).send({ error: code });
  }

  async function principalFrom(request: FastifyRequest): Promise<AuthenticatedPrincipal> {
    return await authenticateBearerToken(
      prisma,
      request.headers.authorization,
      dependencies.authSigningSecret,
      Math.floor(now().getTime() / 1000),
    );
  }

  app.get("/health", async () => ({
    status: "ok",
    service: "autonomagent-api",
    tradingMode: config.tradingMode,
    liveTradingEnabled: config.liveTradingEnabled,
    testnetEnabled: config.testnetEnabled,
    emergencyStop: config.emergencyStop,
    tradingReady: false,
    note: "Health only. Trading endpoints are not implemented.",
  }));

  app.get("/v1/listings", async (request, reply) => {
    try {
      const principal = await principalFrom(request);
      if (!dependencies.listingStore) throw new Error("LISTING_STORAGE_NOT_CONFIGURED");
      const query = request.query as Record<string, unknown>;
      const limit = query.limit === undefined ? 50 : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("LISTING_LIMIT_INVALID");
      }
      const listings = await dependencies.listingStore.listForUser(principal.userId, limit);
      return reply.code(200).send({ listings: listings.map(serializeListing) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/v1/listings/search", async (request, reply) => {
    try {
      const principal = await principalFrom(request);
      if (!dependencies.listingStore) throw new Error("LISTING_STORAGE_NOT_CONFIGURED");
      const body = request.body as { query?: unknown; limit?: unknown } | undefined;
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      if (!query || query.length > 200) throw new Error("LISTING_QUERY_INVALID");
      const limit = body?.limit === undefined ? 30 : body.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new Error("LISTING_SEARCH_LIMIT_INVALID");
      }
      const hasEbay = dependencies.providers?.list().some(({ providerId }) => providerId === "ebay");
      if (!hasEbay || !dependencies.providers) throw new Error("EBAY_API_NOT_CONFIGURED");
      const provider = dependencies.providers.getForCapability("ebay", "PRODUCT_SEARCH");
      if (!provider.searchProducts) throw new Error("EBAY_API_NOT_CONFIGURED");
      const products = await provider.searchProducts({ query, limit, currency: "EUR" });
      if (products.length > limit) throw new Error("EBAY_RESPONSE_INVALID");
      const listings = await dependencies.listingStore.upsertForUser(principal.userId, products);
      return reply.code(200).send({ listings: listings.map(serializeListing) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/v1/auth/login", async (request, reply) => {
    const body = request.body as { email?: unknown; password?: unknown } | undefined;
    if (typeof body?.email !== "string" || !body.email.trim() || typeof body.password !== "string") {
      return reply.code(400).send({ error: "LOGIN_FIELDS_REQUIRED" });
    }
    try {
      const tokens = await loginWithPassword(
        prisma,
        { email: body.email, password: body.password },
        signingSecret(),
        now(),
      );
      return reply.code(200).send(tokens);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/v1/auth/refresh", async (request, reply) => {
    const body = request.body as { refreshToken?: unknown } | undefined;
    if (typeof body?.refreshToken !== "string" || !body.refreshToken) {
      return reply.code(400).send({ error: "REFRESH_TOKEN_REQUIRED" });
    }
    try {
      const tokens = await rotateRefreshToken(prisma, body.refreshToken, signingSecret(), now());
      return reply.code(200).send(tokens);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const body = request.body as { refreshToken?: unknown } | undefined;
    if (typeof body?.refreshToken !== "string" || !body.refreshToken) {
      return reply.code(400).send({ error: "REFRESH_TOKEN_REQUIRED" });
    }
    try {
      await revokeRefreshToken(prisma, body.refreshToken, now());
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/v1/deals", async (request, reply) => {
    try {
      await principalFrom(request);
      const query = request.query as Record<string, unknown>;
      const reviewStatus = query.reviewStatus;
      if (reviewStatus !== undefined && !REVIEW_STATUSES.includes(reviewStatus as never)) {
        return reply.code(400).send({ error: "DEAL_REVIEW_STATUS_INVALID" });
      }
      let riskPassed: boolean | undefined;
      if (query.riskPassed !== undefined) {
        if (query.riskPassed !== "true" && query.riskPassed !== "false") {
          return reply.code(400).send({ error: "DEAL_RISK_FILTER_INVALID" });
        }
        riskPassed = query.riskPassed === "true";
      }
      let limit: number | undefined;
      if (query.limit !== undefined) {
        const parsed = Number(query.limit);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DEAL_LIMIT) {
          return reply.code(400).send({ error: "DEAL_LIST_LIMIT_INVALID" });
        }
        limit = parsed;
      }
      const deals = await listDealCandidates(prisma, {
        ...(reviewStatus === undefined ? {} : { reviewStatus: reviewStatus as (typeof REVIEW_STATUSES)[number] }),
        ...(riskPassed === undefined ? {} : { riskPassed }),
        ...(limit === undefined ? {} : { limit }),
      });
      return reply.code(200).send({ deals: deals.map(serializeDeal) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/v1/deals/:dealId/treasure-analysis", async (request, reply) => {
    try {
      const principal = await principalFrom(request);
      requireAdmin(principal);
      const { dealId } = request.params as { dealId: string };
      const body = request.body as { imageUrl?: unknown } | undefined;
      const imageUrl = body?.imageUrl;
      if (typeof imageUrl !== "string" || imageUrl.length > 2048 || !imageUrl.startsWith("https://")) {
        throw new Error("TREASURE_ANALYSIS_INPUT_INVALID");
      }
      const suppliedKey = request.headers["x-idempotency-key"];
      if (typeof suppliedKey !== "string" || suppliedKey.length < 8 || suppliedKey.length > 128) {
        throw new Error("TREASURE_ANALYSIS_IDEMPOTENCY_REQUIRED");
      }
      const deal = await prisma.dealCandidate.findUnique({ where: { id: dealId } });
      if (!deal) throw new Error("DEAL_CANDIDATE_NOT_FOUND");
      const input = { dealId: deal.id, imageUrl, title: deal.title, productUrl: deal.productUrl,
        purchasePriceMinor: deal.purchasePriceMinor.toString(), totalCostCents: deal.totalCostCents.toString(),
        currency: deal.currency };
      const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const idempotencyKey = createHash("sha256").update(principal.userId + ":" + suppliedKey).digest("hex");
      const existing = await prisma.agentTask.findUnique({ where: { idempotencyKey } });
      if (existing) {
        if (existing.inputHash !== inputHash) throw new Error("TREASURE_ANALYSIS_IDEMPOTENCY_CONFLICT");
        return reply.code(202).send({ taskId: existing.id, status: existing.status,
          correlationId: existing.correlationId, execution: "PENDING_WORKER" });
      }
      const correlationId = randomUUID();
      const task = await prisma.$transaction(async (tx) => {
        const created = await tx.agentTask.create({ data: { ownerId: principal.userId,
          taskType: "HIDDEN_TREASURE_ANALYSIS", status: "QUEUED", input, inputHash,
          correlationId, idempotencyKey, maxAttempts: 3 } });
        await tx.outboxEvent.create({ data: { eventType: "hidden_treasure.analysis.requested",
          aggregateId: created.id, correlationId, payload: { taskId: created.id, taskType: created.taskType } } });
        return created;
      });
      return reply.code(202).send({ taskId: task.id, status: task.status, correlationId,
        execution: "PENDING_WORKER" });
    } catch (error) { return fail(reply, error); }
  });

  app.get("/v1/treasure-analyses/:taskId", async (request, reply) => {
    try {
      const principal = await principalFrom(request);
      const { taskId } = request.params as { taskId: string };
      const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
      if (!task || (task.ownerId !== principal.userId && principal.role !== "ADMIN") ||
          task.taskType !== "HIDDEN_TREASURE_ANALYSIS") throw new Error("AGENT_TASK_NOT_FOUND");
      return reply.code(200).send({ taskId: task.id, status: task.status, result: task.result,
        correlationId: task.correlationId, attempt: task.attempt,
        createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(),
        finishedAt: task.finishedAt?.toISOString() ?? null, hasError: Boolean(task.lastError) });
    } catch (error) { return fail(reply, error); }
  });
  app.post("/v1/deals/:dealId/vision-inspection", async (request, reply) => {
    try {
      const principal = await principalFrom(request);
      requireAdmin(principal);
      if (!dependencies.visionInspector) throw new Error("VISION_INSPECTOR_NOT_CONFIGURED");
      const { dealId } = request.params as { dealId: string };
      const body = request.body as { imageUrl?: unknown } | undefined;
      if (typeof body?.imageUrl !== "string" || !body.imageUrl.trim() || body.imageUrl.length > 2048) {
        return reply.code(400).send({ error: "VISION_IMAGE_URL_REQUIRED" });
      }
      const deal = await prisma.dealCandidate.findUnique({ where: { id: dealId } });
      if (!deal) throw new Error("DEAL_CANDIDATE_NOT_FOUND");
      const inspection = await dependencies.visionInspector.inspectItemVisuals(
        body.imageUrl,
        deal.title,
      );
      return reply.code(200).send({
        dealId: deal.id,
        inspection,
        purchaseAuthorized: false,
        authenticityVerified: false,
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/v1/deals/:dealId/review", async (request, reply) => {
    try {
      const principal = await principalFrom(request);
      requireAdmin(principal);
      const { dealId } = request.params as { dealId: string };
      const body = request.body as { decision?: unknown } | undefined;
      if (typeof body?.decision !== "string" || !REVIEW_DECISIONS.includes(body.decision as ReviewDecision)) {
        return reply.code(400).send({ error: "DEAL_REVIEW_DECISION_INVALID" });
      }
      const reviewed = await reviewDealCandidate(prisma, {
        dealId,
        reviewerId: principal.userId,
        decision: body.decision as ReviewDecision,
      });
      return reply.code(200).send({ deal: serializeDeal(reviewed) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/v1/operations/overview", async (_request, reply) => {
    return reply.code(503).send({
      error: "BACKEND_NOT_READY",
      message: "Operations data is unavailable until authenticated sessions are configured.",
    });
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ error: "NOT_FOUND" });
  });

  return app;
}
