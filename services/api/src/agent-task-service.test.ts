import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { canonicalizeTaskInput, hashTaskInput, saveTaskCheckpoint } from "./agent-task-service.js";

describe("agent task lifecycle contract", () => {
  it("documents terminal and resumable states", () => {
    const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"];
    const resumable = ["QUEUED", "CHECKPOINTED"];
    expect(terminal).toHaveLength(3);
    expect(resumable).toContain("CHECKPOINTED");
  });

  it("hashes JSON objects canonically while preserving array order", () => {
    const left = { z: { second: 2, first: 1 }, a: [{ y: true, x: "value" }] };
    const right = { a: [{ x: "value", y: true }], z: { first: 1, second: 2 } };
    expect(hashTaskInput(left)).toBe(hashTaskInput(right));
    expect(canonicalizeTaskInput(left)).toEqual({ a: [{ x: "value", y: true }], z: { first: 1, second: 2 } });
    expect(hashTaskInput({ values: [1, 2] })).not.toBe(hashTaskInput({ values: [2, 1] }));
  });

  it("rejects non-JSON values and cyclic task input", () => {
    expect(() => hashTaskInput({ value: Number.NaN })).toThrow("TASK_INPUT_NOT_JSON");
    expect(() => hashTaskInput({ value: undefined })).toThrow("TASK_INPUT_NOT_JSON");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => hashTaskInput(cyclic)).toThrow("TASK_INPUT_NOT_JSON");
    expect(() => hashTaskInput([])).toThrow("TASK_INPUT_MUST_BE_OBJECT");
  });
});


describe("durable task checkpoints", () => {
  function prismaForUpdate(count: number) {
    const tx = {
      agentTask: {
        updateMany: vi.fn().mockResolvedValue({ count }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "task-1", correlationId: "corr-1" }),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({ id: "event-1" }) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    return { prisma, tx };
  }

  it("stores a checkpoint only while the worker owns a live lease", async () => {
    const { prisma, tx } = prismaForUpdate(1);
    const checkpoint = {
      schema_version: 1,
      findings: { visual_identification: { role: "visual_identification", status: "SUCCEEDED" } },
    };
    await saveTaskCheckpoint(prisma, "task-1", "worker-1", checkpoint);

    expect(tx.agentTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "task-1", status: "RUNNING", lockedBy: "worker-1",
        leaseUntil: expect.objectContaining({ gt: expect.any(Date) }),
      }),
      data: { checkpoint },
    }));
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
  });

  it("rejects checkpoint writes after lease loss", async () => {
    const { prisma, tx } = prismaForUpdate(0);
    await expect(saveTaskCheckpoint(prisma, "task-1", "stale-worker", {
      schema_version: 1, findings: {},
    })).rejects.toThrow("TASK_LEASE_LOST");
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
});
