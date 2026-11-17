import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const workerId = process.env.AGENT_WORKER_ID ?? "treasure-worker-" + randomUUID();
const endpoint = process.env.VISION_WORKER_URL;
const token = process.env.VISION_WORKER_TOKEN;
const pollMs = Number(process.env.AGENT_WORKER_POLL_INTERVAL_MS ?? "1500");

if (!endpoint || !token || token.length < 32) {
  throw new Error("VISION_WORKER_URL and a 32-character VISION_WORKER_TOKEN are required");
}
if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 30000) {
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

  const leaseUntil = new Date(now.getTime() + 120_000);
  const claimed = await prisma.agentTask.updateMany({
    where: {
      id: candidate.id,
      OR: [
        { status: "QUEUED", availableAt: { lte: now } },
        { status: "RUNNING", leaseUntil: { lte: now } },
      ],
    },
    data: {
      status: "RUNNING",
      lockedBy: workerId,
      leaseUntil,
      attempt: { increment: 1 },
      startedAt: candidate.startedAt ?? now,
      lastError: null,
    },
  });
  if (claimed.count !== 1) return null;
  return prisma.agentTask.findUnique({ where: { id: candidate.id } });
}

function safeMinor(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("TASK_INPUT_INVALID_" + field);
  }
  const amount = BigInt(value);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("TASK_INPUT_OUT_OF_RANGE_" + field);
  }
  return Number(amount);
}

async function execute(task: NonNullable<Awaited<ReturnType<typeof claimTask>>>) {
  const input = task.input as unknown as Record<string, unknown>;
  try {
    const purchasePrice = safeMinor(input.purchasePriceMinor, "PURCHASE_PRICE");
    const totalCost = safeMinor(input.totalCostCents, "TOTAL_COST");
    const response = await fetch(new URL("/v1/analyze", endpoint), {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        candidate_id: String(input.dealId ?? ""),
        title: String(input.title ?? ""),
        description: "",
        image_url: String(input.imageUrl ?? ""),
        asking_price_minor: purchasePrice,
        known_costs_minor: Math.max(0, totalCost - purchasePrice),
        currency: String(input.currency ?? "EUR"),
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error("VISION_WORKER_HTTP_" + response.status);
    const result: unknown = await response.json();
    await prisma.agentTask.updateMany({
      where: { id: task.id, status: "RUNNING", lockedBy: workerId },
      data: {
        status: "SUCCEEDED",
        result: result as object,
        finishedAt: new Date(),
        leaseUntil: null,
        lockedBy: null,
        lastError: null,
      },
    });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_:-]{1,80}$/.test(error.message)
      ? error.message : "TREASURE_ANALYSIS_EXECUTION_FAILED";
    const terminal = task.attempt >= task.maxAttempts;
    const delay = Math.min(60_000, 2_000 * (2 ** Math.max(0, task.attempt - 1)));
    await prisma.agentTask.updateMany({
      where: { id: task.id, status: "RUNNING", lockedBy: workerId },
      data: {
        status: terminal ? "FAILED" : "QUEUED",
        availableAt: new Date(Date.now() + delay),
        finishedAt: terminal ? new Date() : null,
        leaseUntil: null,
        lockedBy: null,
        lastError: code,
      },
    });
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
    (error instanceof Error ? error.message : "unknown error") + "\n");
  await prisma.$disconnect();
  process.exitCode = 1;
});
