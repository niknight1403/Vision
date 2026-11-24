import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { canonicalizeTaskInput, PermanentTaskError } from "./agent-task-service.js";
import { runAgentOrchestrator, type TaskHandler } from "./agent-orchestrator.js";
import { FreeRouteRouter, RouteFailure } from "./providers/free-route-router.js";

const workerId = process.env.AGENT_WORKER_ID ?? "treasure-worker-" + randomUUID();
const endpoint = process.env.VISION_WORKER_URL;
const token = process.env.VISION_WORKER_TOKEN;
const pollMs = Number(process.env.AGENT_WORKER_POLL_INTERVAL_MS ?? "1500");
const concurrency = Number(process.env.AGENT_WORKER_CONCURRENCY ?? "1");
if (!endpoint || !token || token.length < 32) throw new Error("VISION_WORKER_URL and a 32-character VISION_WORKER_TOKEN are required");
if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 30000) throw new Error("AGENT_WORKER_POLL_INTERVAL_MS must be between 250 and 30000");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("INVALID_AGENT_WORKER_CONCURRENCY");
const analysisUrl = new URL("/v1/analyze", endpoint);
const fallbackEndpoint = process.env.VISION_FREE_FALLBACK_URL;
const fallbackToken = process.env.VISION_FREE_FALLBACK_TOKEN;
if (fallbackEndpoint && process.env.VISION_ROUTES_ZERO_COST_CONFIRMED !== "true") throw new Error("VISION_ROUTE_COST_UNCONFIRMED");
if (Boolean(fallbackEndpoint) !== Boolean(fallbackToken)) throw new Error("INCOMPLETE_VISION_FALLBACK_CONFIG");
const fallbackUrl = fallbackEndpoint ? new URL("/v1/analyze", fallbackEndpoint) : undefined;
if (fallbackUrl && (fallbackUrl.protocol !== "https:" || fallbackUrl.username || fallbackUrl.password || !fallbackToken || fallbackToken.length < 32)) throw new Error("INVALID_VISION_FALLBACK_CONFIG");
const router = new FreeRouteRouter();
const prisma = new PrismaClient();
const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

function safeMinor(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new PermanentTaskError("TASK_INPUT_INVALID_" + field);
  const amount = BigInt(value);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new PermanentTaskError("TASK_INPUT_OUT_OF_RANGE_" + field);
  return Number(amount);
}

const analyze: TaskHandler = async (task, context) => {
  if (!task.input || typeof task.input !== "object" || Array.isArray(task.input)) throw new PermanentTaskError("TASK_INPUT_MUST_BE_OBJECT");
  const input = task.input as Record<string, unknown>;
  const purchasePrice = safeMinor(input.purchasePriceMinor, "PURCHASE_PRICE");
  const totalCost = safeMinor(input.totalCostCents, "TOTAL_COST");
  const request = (url: URL, credential: string, signal: AbortSignal) => fetch(url, {
    method: "POST",
    headers: { authorization: "Bearer " + credential, "content-type": "application/json" },
    body: JSON.stringify({
      candidate_id: String(input.dealId ?? ""), title: String(input.title ?? ""),
      description: "", image_url: String(input.imageUrl ?? ""),
      asking_price_minor: purchasePrice, known_costs_minor: Math.max(0, totalCost - purchasePrice),
      currency: String(input.currency ?? "EUR"),
    }),
    signal, redirect: "error",
  });
  const signal = AbortSignal.any([context.signal, shutdown.signal]);
  const invoke = async (url: URL, credential: string, attemptSignal: AbortSignal) => {
    const response = await request(url, credential, attemptSignal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new RouteFailure(response.status === 429 || response.status >= 500);
    }
    return canonicalizeTaskInput(await response.json());
  };
  if (!fallbackUrl || !fallbackToken) {
    return invoke(analysisUrl, token!, AbortSignal.any([signal, AbortSignal.timeout(90_000)]));
  }
  const result = await router.execute([
    { id: "primary-vision", cost: "FREE", execute: (s) => invoke(analysisUrl, token!, s) },
    { id: "fallback-vision", cost: "FREE", execute: (s) => invoke(fallbackUrl, fallbackToken, s) },
  ], signal);
  return result.value;
};

async function main() {
  try {
    await runAgentOrchestrator(prisma, {
      workerId, concurrency, pollIntervalMs: pollMs, leaseSeconds: 120, heartbeatIntervalMs: 25_000,
    }, { HIDDEN_TREASURE_ANALYSIS: analyze }, shutdown.signal);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error: unknown) => {
  process.stderr.write("Agent task worker stopped: " + (error instanceof Error ? error.message : "unknown error") + "\n");
  process.exitCode = 1;
});
