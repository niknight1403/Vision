import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import type { DealCandidate, PrismaClient } from "@prisma/client";
import { config } from "./config.js";
import { authenticateBearerToken, requireAdmin, requireOperator, type AuthenticatedPrincipal } from "./auth-service.js";
import { loginWithPassword, revokeRefreshToken, rotateRefreshToken } from "./auth-session-service.js";
import { listDealCandidates, reviewDealCandidate } from "./deal-candidate-service.js";
import { runAndPersistDealScan } from "./deal-scan-service.js";
import { createAgentTask, hashTaskInput } from "./agent-task-service.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { createMetrics } from "./observability.js";
import { outboxStatusCounts } from "./outbox-worker.js";
import {
  rateLimitConfigFromEnv,
  retryAfterSeconds,
  SlidingWindowRateLimiter,
  type RateLimitConfig,
} from "./api-hardening.js";

export interface ServerDependencies {
  prisma: PrismaClient;
  /** HS256 signing secret for access tokens; unset means the auth routes stay closed. */
  authSigningSecret?: string | undefined;
  now?: () => Date;
  /** Optional allowlist-enforcing vision worker adapter; absent means inspection stays unavailable. */
  visionInspector?: {
    inspectItemVisuals(imageUrl: string, hintTitle: string): Promise<Record<string, unknown>>;
  };
  providers?: ProviderRegistry;
  /** Overrides for the in-process limiters; defaults come from the environment. */
  rateLimits?: { auth: RateLimitConfig; scan: RateLimitConfig; analysis: RateLimitConfig };
  /** Bearer token that unlocks GET /metrics; unset keeps the route closed. */
  metricsToken?: string;
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
  OPERATOR_ROLE_REQUIRED: 403,
  OPERATIONS_DATABASE_UNAVAILABLE: 503,
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
  PROVIDER_NOT_CONFIGURED: 503,
  DEAL_SCAN_INPUT_INVALID: 400,
  DEAL_SCAN_FAILED: 502,
  TREASURE_ANALYSIS_IDEMPOTENCY_REQUIRED: 400,
  TREASURE_ANALYSIS_IDEMPOTENCY_CONFLICT: 409,
  TREASURE_ANALYSIS_INPUT_INVALID: 400,
  AGENT_TASK_NOT_FOUND: 404,
  RATE_LIMIT_EXCEEDED: 429,
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

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : "INTERNAL_ERROR";
}

export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const { prisma } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", requestIdHeader: "x-request-id" });

  await app.register(helmet);
  await app.register(cors, { origin: false });

  function signingSecret(): string {
    if (!dependencies.authSigningSecret) throw new Error("AUTH_SIGNING_SECRET_NOT_CONFIGURED");
    return dependencies.authSigningSecret;
  }

  const metrics = createMetrics();
  let inFlight = 0;
  app.addHook("onRequest", async (request) => {
    inFlight += 1;
    metrics.setGauge("http_requests_in_flight", {}, inFlight);
    (request as FastifyRequest & { metricsStartedAt?: number }).metricsStartedAt = Date.now();
  });
  app.addHook("onSend", async (request, reply, payload) => {
    // Echo the correlation id the client sent (or the one Fastify generated).
    reply.header("x-request-id", request.id);
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    inFlight = Math.max(0, inFlight - 1);
    metrics.setGauge("http_requests_in_flight", {}, inFlight);
    const route = request.routeOptions?.url ?? "unmatched";
    metrics.increment("http_requests_total", { route, method: request.method, status: String(reply.statusCode) });
    const started = (request as FastifyRequest & { metricsStartedAt?: number }).metricsStartedAt;
    if (typeof started === "number") {
      metrics.increment("http_request_duration_ms_total", { route }, Date.now() - started);
    }
  });

  const rateLimits = dependencies.rateLimits ?? {
    auth: rateLimitConfigFromEnv(process.env, { max: "AUTH_RATE_LIMIT_MAX", window: "AUTH_RATE_LIMIT_WINDOW_MS" },
      { maxHits: 10, windowMs: 60_000 }),
    scan: rateLimitConfigFromEnv(process.env, { max: "SCAN_RATE_LIMIT_MAX", window: "SCAN_RATE_LIMIT_WINDOW_MS" },
      { maxHits: 30, windowMs: 60_000 }),
    analysis: rateLimitConfigFromEnv(process.env, { max: "ANALYSIS_RATE_LIMIT_MAX", window: "ANALYSIS_RATE_LIMIT_WINDOW_MS" },
      { maxHits: 20, windowMs: 60_000 }),
  };
  const limiters = {
    auth: new SlidingWindowRateLimiter(rateLimits.auth.maxHits, rateLimits.auth.windowMs, rateLimits.auth.maxKeys),
    scan: new SlidingWindowRateLimiter(rateLimits.scan.maxHits, rateLimits.scan.windowMs, rateLimits.scan.maxKeys),
    analysis: new SlidingWindowRateLimiter(rateLimits.analysis.maxHits, rateLimits.analysis.windowMs, rateLimits.analysis.maxKeys),
  };

  /**
   * Enforce one limiter for one principal. Returns false when the reply was
   * already sent, so the caller must return immediately.
   */
  function withinRateLimit(
    limiter: SlidingWindowRateLimiter,
    key: string,
    reply: FastifyReply,
  ): boolean {
    const decision = limiter.check(key);
    reply.header("x-ratelimit-remaining", String(decision.remaining));
    if (decision.allowed) return true;
    const wait = retryAfterSeconds(decision);
    reply.header("retry-after", String(wait));
    reply.code(429).send({ error: "RATE_LIMIT_EXCEEDED", retryAfterSeconds: wait });
    return false;
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

  async function databaseReady(): Promise<boolean> {
    try { await prisma.$queryRaw`SELECT 1`; return true; } catch { return false; }
  }

  app.get("/livez", async () => ({ status: "ok", service: "autonomagent-api" }));
  app.get("/readyz", async (_request, reply) => {
    const db = await databaseReady();
    return reply.code(db ? 200 : 503).send({ status: db ? "ready" : "not_ready", database: db ? "reachable" : "unavailable", tradingReady: false });
  });

  app.get("/health", async (_request, reply) => {
    const db = await databaseReady();
    return reply.code(db ? 200 : 503).send({
    status: db ? "ok" : "degraded",
    service: "autonomagent-api",
    tradingMode: config.tradingMode,
    liveTradingEnabled: config.liveTradingEnabled,
    testnetEnabled: config.testnetEnabled,
    emergencyStop: config.emergencyStop,
    tradingReady: false,
    database: db ? "reachable" : "unavailable",
    readiness: db,
    providerConfigured: Boolean(dependencies.providers?.list().length),
    providers: dependencies.providers?.list() ?? [],
    note: "Autonomous sourcing and analysis only; mutating marketplace actions require a reviewed adapter.",
  });
  });

  app.get("/metrics", async (request, reply) => {
    const expected = dependencies.metricsToken;
    if (!expected || expected.length < 16) {
      return reply.code(503).send({ error: "METRICS_NOT_CONFIGURED" });
    }
    const authorization = request.headers.authorization;
    if (!authorization || !timingSafeEqualString(authorization, "Bearer " + expected)) {
      return reply.code(401).send({ error: "METRICS_AUTH_REQUIRED" });
    }
    try {
      const counts = await outboxStatusCounts(prisma);
      for (const [status, value] of Object.entries(counts)) {
        metrics.setGauge("outbox_events", { status }, value);
      }
      const tasks = await prisma.agentTask.groupBy({ by: ["status"], _count: { _all: true } });
      const taskCounts: Record<string, number> = {
        QUEUED: 0, RUNNING: 0, CHECKPOINTED: 0, SUCCEEDED: 0, FAILED: 0, CANCELLED: 0,
      };
      for (const row of tasks) taskCounts[row.status] = row._count._all;
      for (const [status, value] of Object.entries(taskCounts)) {
        metrics.setGauge("agent_tasks", { status }, value);
      }
    } catch (error) {
      // A database hiccup must not hide the process metrics that already exist.
      reply.log.error({ err: error }, "metrics gauge collection failed");
    }
    return reply.type("text/plain; version=0.0.4").send(metrics.render());
  });

  app.post("/v1/auth/login", async (request, reply) => {
    if (!withinRateLimit(limiters.auth, "ip:" + request.ip, reply)) return reply;
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
    if (!withinRateLimit(limiters.auth, "ip:" + request.ip, reply)) return reply;
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

  app.post("/v1/deals/scan", async (request, reply) => {
    try {
      const principal = await principalFrom(request);
      requireAdmin(principal);
      if (!withinRateLimit(limiters.scan, "user:" + principal.userId, reply)) return reply;
      if (!dependencies.providers) throw new Error("PROVIDER_NOT_CONFIGURED");
      const body = request.body as Record<string, unknown> | undefined;
      const query = body?.query;
      const limit = body?.limit;
      if (typeof query !== "string" || !query.trim() || query.length > 200 ||
          !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50 || body?.currency !== "EUR") {
        throw new Error("DEAL_SCAN_INPUT_INVALID");
      }
      const bigintField = (name: string): bigint => {
        const value = body?.[name];
        if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("DEAL_SCAN_INPUT_INVALID");
        return BigInt(value);
      };
      const result = await runAndPersistDealScan(
        { prisma, providers: dependencies.providers },
        {
          providerId: typeof body?.providerId === "string" ? body.providerId : "catalog-live",
          query,
          limit: Number(limit),
          currency: "EUR",
          costs: {
            inboundShippingCents: bigintField("inboundShippingCents"),
            outboundShippingCents: bigintField("outboundShippingCents"),
            marketplaceFeeCents: bigintField("marketplaceFeeCents"),
            paymentFeeCents: bigintField("paymentFeeCents"),
            packagingCents: bigintField("packagingCents"),
            riskReserveCents: bigintField("riskReserveCents"),
          },
          context: {
            resalePriceCents: bigintField("resalePriceCents"),
            openTrades: typeof body?.openTrades === "number" ? body.openTrades : 0,
            dailyLossCents: bigintField("dailyLossCents"),
            riskLimits: {
              maxTradeCents: bigintField("maxTradeCents"),
              minProfitCents: bigintField("minProfitCents"),
              minRoiBasisPoints: bigintField("minRoiBasisPoints"),
              maxOpenTrades: typeof body?.maxOpenTrades === "number" ? body.maxOpenTrades : 0,
              maxDailyLossCents: bigintField("maxDailyLossCents"),
            },
          },
        },
      );
      return reply.code(200).send(result);
    } catch (error) {
      const code = errorCode(error);
      if (code.startsWith("Provider ") || code === "PROVIDER_NOT_CONFIGURED") return fail(reply, new Error("PROVIDER_NOT_CONFIGURED"));
      if (code === "DEAL_SCAN_INPUT_INVALID") return fail(reply, error);
      return fail(reply, new Error("DEAL_SCAN_FAILED"));
    }
  });

  app.post("/v1/deals/:dealId/treasure-analysis", async (request, reply) => {
    try {
      const principal = await principalFrom(request);
      requireAdmin(principal);
      if (!withinRateLimit(limiters.analysis, "user:" + principal.userId, reply)) return reply;
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
      const inputHash = hashTaskInput(input);
      const idempotencyKey = createHash("sha256").update(principal.userId + ":" + suppliedKey).digest("hex");
      const existing = await prisma.agentTask.findUnique({ where: { idempotencyKey } });
      if (existing) {
        if (existing.inputHash !== inputHash) throw new Error("TREASURE_ANALYSIS_IDEMPOTENCY_CONFLICT");
        return reply.code(202).send({ taskId: existing.id, status: existing.status,
          correlationId: existing.correlationId, execution: "PENDING_WORKER" });
      }
      const correlationId = randomUUID();
      const task = await createAgentTask(prisma, {
        ownerId: principal.userId, taskType: "HIDDEN_TREASURE_ANALYSIS", input,
        idempotencyKey, correlationId, maxAttempts: 3,
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
      if (!withinRateLimit(limiters.analysis, "user:" + principal.userId, reply)) return reply;
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

  app.get("/v1/operations/overview", async (request, reply) => {
    try {
      const principal = await principalFrom(request);
      requireOperator(principal);
      const [pendingTasks, runningTasks, failedTasks, pendingOutbox, processingOutbox, deadLetters, blockedKillSwitches] = await Promise.all([
        prisma.agentTask.count({ where: { status: "QUEUED" } }),
        prisma.agentTask.count({ where: { status: "RUNNING" } }),
        prisma.agentTask.count({ where: { status: "FAILED" } }),
        prisma.outboxEvent.count({ where: { status: "PENDING" } }),
        prisma.outboxEvent.count({ where: { status: "PROCESSING" } }),
        prisma.outboxEvent.count({ where: { status: "DEAD_LETTER" } }),
        prisma.testnetKillSwitch.count({ where: { state: { not: "ARMED" } } }),
      ]);
      return reply.code(200).send({
        status: "OBSERVED", readOnly: true,
        config: { tradingMode: config.tradingMode, liveTradingEnabled: false, testnetEnabled: false, emergencyStop: config.emergencyStop },
        providers: (dependencies.providers?.list() ?? []).map(({ providerId, displayName, capabilities, simulated }) => ({ providerId, displayName, capabilities, simulated })),
        queue: { pendingTasks, runningTasks, failedTasks },
        outbox: { pending: pendingOutbox, processing: processingOutbox, deadLetters },
        killSwitch: { blockedScopes: blockedKillSwitches, failClosed: true },
        database: { reachable: true },
      });
    } catch (error) {
      const code = errorCode(error);
      if (["AUTHENTICATION_REQUIRED", "AUTH_TOKEN_INVALID", "AUTH_TOKEN_EXPIRED_OR_NOT_ACTIVE", "AUTHENTICATED_USER_UNAVAILABLE", "AUTH_SIGNING_SECRET_NOT_CONFIGURED", "OPERATOR_ROLE_REQUIRED"].includes(code)) return fail(reply, error);
      return fail(reply, new Error("OPERATIONS_DATABASE_UNAVAILABLE"));
    }
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ error: "NOT_FOUND" });
  });

  return app;
}
