import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { createAgentTask, saveTaskCheckpoint } from "./agent-task-service.js";

const enabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!enabled);
const prisma = new PrismaClient();
const ownerId = `worker-process-restart-${process.pid}`;
const taskIds: string[] = [];
const token = "integration-worker-token-that-is-long-enough-123456";
const workerEntry = fileURLToPath(new URL("./agent-task-worker.ts", import.meta.url));

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

function sendJson(reply: ServerResponse, status: number, value: unknown) {
  reply.writeHead(status, { "content-type": "application/json" });
  reply.end(JSON.stringify(value));
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

suite("agent worker process restart (PostgreSQL)", () => {
  let server: Server;
  let baseUrl = "";
  let checkpointSaved!: () => void;
  const checkpointReady = new Promise<void>((resolve) => { checkpointSaved = resolve; });
  let analyzeCalls = 0;
  let replacementCheckpoint: unknown;

  beforeAll(async () => {
    await prisma.$connect();
    server = createServer(async (request, reply) => {
      try {
        if (request.method === "POST" && typeof request.url === "string" && /^\\/internal\\/agent-tasks\\/[^/]+\\/checkpoint$/.test(request.url)) {
          const body = await readJson(request);
          if (request.headers.authorization !== `Bearer ${token}`) return sendJson(reply, 401, { error: "unauthorized" });
          const workerId = body.workerId;
          const checkpoint = body.checkpoint;
          if (typeof workerId !== "string" || !checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
            return sendJson(reply, 400, { error: "invalid checkpoint" });
          }
          await saveTaskCheckpoint(prisma, taskIds[0], workerId, checkpoint as Prisma.InputJsonObject);
          checkpointSaved();
          return sendJson(reply, 200, { taskId: taskIds[0], checkpointed: true });
        }

        if (request.method === "POST" && request.url === "/v1/analyze") {
          const body = await readJson(request);
          analyzeCalls += 1;
          if (analyzeCalls === 1) {
            const checkpoint = {
              schema_version: 1,
              findings: {
                market_research: { role: "market_research", summary: "checkpoint persisted before process termination" },
              },
            };
            const callback = await fetch(`${baseUrl}/internal/agent-tasks/test/checkpoint`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ workerId: body.worker_id, checkpoint }),
            });
            if (!callback.ok) throw new Error(`checkpoint callback failed: ${callback.status}`);
            // Hold the request open so the parent can SIGKILL the real worker process
            // after the checkpoint has been durably committed.
            return;
          }
          replacementCheckpoint = body.checkpoint;
          return sendJson(reply, 200, {
            assessment: { status: "completed_after_restart" },
            purchase_authorized: false,
            authenticity_verified: false,
          });
        }
        sendJson(reply, 404, { error: "not found" });
      } catch (error) {
        sendJson(reply, 500, { error: error instanceof Error ? error.message : "server error" });
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server?.close();
    if (taskIds.length) {
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: taskIds } } });
      await prisma.agentTask.deleteMany({ where: { id: { in: taskIds } } });
    }
    await prisma.$disconnect();
  });

  it("kills a worker process after a real checkpoint and resumes from it in a replacement process", async () => {
    const task = await createAgentTask(prisma, {
      ownerId,
      taskType: "HIDDEN_TREASURE_ANALYSIS",
      input: {
        dealId: "restart-test-deal",
        imageUrl: "https://images.example.com/item.jpg",
        title: "Restart integration fixture",
        purchasePriceMinor: "1000",
        totalCostCents: "1200",
        currency: "EUR",
      },
      idempotencyKey: `${ownerId}-one`,
      maxAttempts: 3,
    });
    taskIds.push(task.id);

    const launch = (workerId: string) => spawn(process.execPath, ["--import", "tsx", workerEntry], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_WORKER_ID: workerId,
        AGENT_WORKER_POLL_INTERVAL_MS: "250",
        VISION_WORKER_URL: baseUrl,
        VISION_WORKER_TOKEN: token,
        API_BASE_URL: baseUrl,
      },
      stdio: "ignore",
    });

    const first = launch("restart-worker-one");
    try {
      await Promise.race([
        checkpointReady,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("first worker did not persist checkpoint")), 15_000)),
      ]);
      first.kill("SIGKILL");
      await waitForExit(first);

      const crashed = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(crashed.status).toBe("RUNNING");
      expect(crashed.checkpoint).toMatchObject({
        schema_version: 1,
        findings: { market_research: { role: "market_research" } },
      });

      await prisma.agentTask.update({
        where: { id: task.id },
        data: { leaseUntil: new Date(Date.now() - 1_000) },
      });

      const replacement = launch("restart-worker-two");
      try {
        await Promise.race([
          (async () => {
            while (true) {
              const current = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
              if (current.status === "SUCCEEDED" || current.status === "FAILED") return current;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          })(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("replacement worker did not finish task")), 15_000)),
        ]);
      } finally {
        replacement.kill("SIGTERM");
        await waitForExit(replacement);
      }

      const completed = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(completed.status).toBe("SUCCEEDED");
      expect(completed.attempt).toBe(2);
      expect(replacementCheckpoint).toMatchObject({
        schema_version: 1,
        findings: { market_research: { role: "market_research" } },
      });
      expect(analyzeCalls).toBe(2);
    } finally {
      if (first.exitCode === null && first.signalCode === null) {
        first.kill("SIGKILL");
        await waitForExit(first);
      }
    }
  }, 40_000);
});

if (!enabled) void prisma.$disconnect();
