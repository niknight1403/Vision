import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  claimAgentTask,
  completeAgentTask,
  failAgentTask,
  PermanentTaskError,
} from "./agent-task-service.js";

const prisma = new PrismaClient();
const workerId = process.env.AGENT_WORKER_ID ?? "treasure-worker-" + randomUUID();
const endpoint = process.env.VISION_WORKER_URL;
const token = process.env.VISION_WORKER_TOKEN;
const pollMs = Number(process.env.AGENT_WORKER_POLL_INTERVAL_MS ?? "1500");
const leaseSeconds = 180;
const requestTimeoutMs = 90_000;

if (!endpoint || !token || token.length < 32) {
  throw new Error("VISION_WORKER_URL and a 32-character VISION_WORKER_TOKEN are required");
}
const workerUrl = new URL(endpoint);
if (workerUrl.protocol !== "https:" && workerUrl.protocol !== "http:") {
  throw new Error("VISION_WORKER_URL must use HTTP or HTTPS");
}
if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 30_000) {
  throw new Error("AGENT_WORKER_POLL_INTERVAL_MS must be between 250 and 30000");
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function claimTask() {
  const now = new Date();
  const candidate = await prisma.agentTask.findFirst({
    where: {
      taskType: "HIDDEN_TREASURE_ANALYSIS",
      OR: [
        { status: "QUEUED", availableAt: { lte: now } },
        { status: "RUNNING", leaseUntil: { lte: now } },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  try {
    return await claimAgentTask(prisma, candidate.id, workerId, leaseSeconds);
  } catch (error) {
    // Another worker may have won the compare-and-set claim.
    if (error instanceof Error && [
      "TASK_NOT_CLAIMABLE", "TASK_CLAIM_CONFLICT", "TASK_ATTEMPTS_EXHAUSTED",
    ].includes(error.message)) return null;
    throw error;
  }
}

function safeMinor(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\\d+$/.test(value)) {
    throw new PermanentTaskError("TASK_INPUT_INVALID_" + field);
  }
  const amount = BigInt(value);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PermanentTaskError("TASK_INPUT_OUT_OF_RANGE_" + field);
  }
  return Number(amount);
}

function asJsonObject(value: unknown): Prisma.InputJsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("VISION_WORKER_RESPONSE_INVALID");
  }
  return value as Prisma.InputJsonObject;
}

async function execute(task: NonNullable<Awaited<ReturnType<typeof claimTask>>>) {
  const input = task.input as Record<string, unknown>;
  try {
    const purchasePrice = safeMinor(input.purchasePriceMinor, "PURCHASE_PRICE");
    const totalCost = safeMinor(input.totalCostCents, "TOTAL_COST");
    if (typeof input.dealId !== "string" || !input.dealId ||
        typeof input.imageUrl !== "string" || !input.imageUrl ||
        typeof input.title !== "string" || !input.title) {
      throw new PermanentTaskError("TASK_INPUT_REQUIRED_FIELDS_MISSING");
    }

    const response = await fetch(new URL("/v1/analyze", workerUrl), {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        candidate_id: input.dealId,
        title: input.title,
        description: "",
        image_url: input.imageUrl,
        asking_price_minor: purchasePrice,
        known_costs_minor: Math.max(0, totalCost - purchasePrice),
        currency: typeof input.currency === "string" ? input.currency : "EUR",
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) throw new Error("VISION_WORKER_HTTP_" + response.status);

    const result = asJsonObject(await response.json());
    await completeAgentTask(prisma, task.id, workerId, result);
  } catch (error) {
    const safeError = error instanceof PermanentTaskError
      ? error
      : new Error(error instanceof Error && /^[A-Z0-9_:-]{1,80}$/.test(error.message)
        ? error.message : "TREASURE_ANALYSIS_EXECUTION_FAILED");
    try {
      await failAgentTask(prisma, task.id, workerId, safeError);
    } catch (leaseError) {
      // A lost/expired lease must never overwrite the state owned by another worker.
      if (!(leaseError instanceof Error) || leaseError.message !== "TASK_LEASE_LOST") {
        throw leaseError;
      }
    }
  }
}

async function main() {
  try {
    while (!stopping) {
      const task = await claimTask();
      if (task) await execute(task);
      else await sleep(pollMs);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (error: unknown) => {
  // Startup/runtime diagnostics are intentionally concise; never print tokens or task input.
  process.stderr.write("Agent task worker stopped: " +
    (error instanceof Error ? error.message : "unknown error") + "\\n");
  await prisma.$disconnect();
  process.exitCode = 1;
});
