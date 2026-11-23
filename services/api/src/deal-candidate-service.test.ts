import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  listDealCandidates,
  persistDealCandidates,
  type PersistableDealAnalysis,
} from "./deal-candidate-service.js";

const deal: PersistableDealAnalysis = {
  providerId: "catalog-demo",
  externalId: "sku-1",
  title: "Camera",
  url: "https://catalog.example/products/sku-1",
  currency: "EUR",
  purchasePriceMinor: 10_000,
  observedAt: "2026-11-17T00:00:00.000Z",
  simulated: false,
  totalCostCents: 12_000n,
  expectedProfitCents: 3_000n,
  roiBasisPoints: 2_500n,
  approvedByRiskRules: true,
  riskReasons: [],
};

function fakePrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    dealCandidate: {
      upsert: vi.fn(async ({ create }: { create: unknown }) => create),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(async () => ({ id: "deal-1" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      ...((overrides.dealCandidate as object | undefined) ?? {}),
    },
  };
  return {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
}

describe("deal candidate persistence", () => {
  it("upserts provider data and resets review to DISCOVERED", async () => {
    const prisma = fakePrisma();
    const result = await persistDealCandidates(prisma, [deal]);
    expect(result).toHaveLength(1);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("rejects duplicate identities and unsupported currencies before writing", async () => {
    const prisma = fakePrisma();
    await expect(persistDealCandidates(prisma, [deal, deal])).rejects.toThrow(/DUPLICATE/);
    await expect(persistDealCandidates(prisma, [{ ...deal, currency: "USD" }]))
      .rejects.toThrow(/CURRENCY/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects invalid list limits", async () => {
    await expect(listDealCandidates(fakePrisma(), { limit: 101 })).rejects.toThrow(/LIMIT/);
  });

  it("never overwrites tenant review state while refreshing shared catalogue data", async () => {
    const prisma = fakePrisma();
    await persistDealCandidates(prisma, [deal]);
    const upsert = prisma.dealCandidate.upsert as unknown as ReturnType<typeof vi.fn>;
    const args = upsert.mock.calls[0]![0] as { create: Record<string, unknown>; update: Record<string, unknown> };
    expect(args.create).not.toHaveProperty("reviewedBy");
    expect(args.update).not.toHaveProperty("reviewStatus");
    expect(args.update).not.toHaveProperty("reviewedBy");
    expect(args.update).not.toHaveProperty("reviewedAt");
  });
});
