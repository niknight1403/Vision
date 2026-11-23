import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { claimNextAgentTask, completeAgentTask, failAgentTask, PermanentTaskError, recoverExpiredAgentTasks } from "./agent-task-service.js";
import { heartbeatTaskLease } from "./agent-orchestrator.js";
const prisma = new PrismaClient();
const workerId = process.env.AGENT_WORKER_ID ?? "treasure-worker-" + randomUUID();
const endpoint = process.env.VISION_WORKER_URL;
const token = process.env.VISION_WORKER_TOKEN;
const pollMs = Number(process.env.AGENT_WORKER_POLL_INTERVAL_MS ?? "1500");
const leaseSeconds = 120;
if (!endpoint || !token || token.length < 32) throw new Error("VISION_WORKER_URL and a 32-character VISION_WORKER_TOKEN are required");
if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 30000) throw new Error("AGENT_WORKER_POLL_INTERVAL_MS must be between 250 and 30000");
let stopping = false;
process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; });
async function claimTask() {
  // A unique owner per claim fences off any stale execution from this process.
  return claimNextAgentTask(prisma, "HIDDEN_TREASURE_ANALYSIS", `${workerId}:${randomUUID()}`, leaseSeconds);
}
function safeMinor(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new PermanentTaskError("TASK_INPUT_INVALID_" + field);
  const amount = BigInt(value); if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new PermanentTaskError("TASK_INPUT_OUT_OF_RANGE_" + field); return Number(amount);
}
async function execute(task: NonNullable<Awaited<ReturnType<typeof claimTask>>>) {
  const input = task.input as Record<string, unknown>; let leaseLost = false;
  const leaseOwner = task.lockedBy;
  if (!leaseOwner) throw new Error("TASK_LEASE_OWNER_MISSING");
  const timer = setInterval(() => void heartbeatTaskLease(prisma, task.id, leaseOwner, leaseSeconds).catch(() => { leaseLost = true; }), 25_000);
  try {
    const purchasePrice = safeMinor(input.purchasePriceMinor, "PURCHASE_PRICE"); const totalCost = safeMinor(input.totalCostCents, "TOTAL_COST");
    const response = await fetch(new URL("/v1/analyze", endpoint), { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ candidate_id: String(input.dealId ?? ""), title: String(input.title ?? ""), description: "", image_url: String(input.imageUrl ?? ""), asking_price_minor: purchasePrice, known_costs_minor: Math.max(0, totalCost - purchasePrice), currency: String(input.currency ?? "EUR") }), signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error("VISION_WORKER_HTTP_" + response.status);
    const result = await response.json() as Prisma.InputJsonObject; if (leaseLost) throw new Error("TASK_LEASE_LOST");
    await completeAgentTask(prisma, task.id, leaseOwner, result);
  } catch (error) { if (!leaseLost) { try { await failAgentTask(prisma, task.id, leaseOwner, error); } catch { /* stale completion fenced */ } } } finally { clearInterval(timer); }
}
async function main() { try { while (!stopping) { await recoverExpiredAgentTasks(prisma); const task = await claimTask(); if (task) await execute(task); else await sleep(pollMs); } } finally { await prisma.$disconnect(); } }
main().catch(async (error: unknown) => { process.stderr.write("Agent task worker stopped: " + (error instanceof Error ? error.message : "unknown error") + "\n"); await prisma.$disconnect(); process.exitCode = 1; });
