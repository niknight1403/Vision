import { Prisma, PrismaClient, type DealReviewStatus } from "@prisma/client";

export interface PersistableDealAnalysis {
  providerId: string;
  externalId: string;
  title: string;
  url: string;
  currency: string;
  purchasePriceMinor: number;
  observedAt: string;
  simulated: boolean;
  totalCostCents: bigint;
  expectedProfitCents: bigint;
  roiBasisPoints: bigint | null;
  approvedByRiskRules: boolean;
  riskReasons: string[];
}

export interface DealCandidateListOptions {
  reviewStatus?: DealReviewStatus;
  riskPassed?: boolean;
  limit?: number;
}

/**
 * Upserts provider observations. A fresh scan resets human review because the
 * underlying price/risk assumptions may have changed since the last review.
 */
export async function persistDealCandidates(
  prisma: PrismaClient,
  deals: readonly PersistableDealAnalysis[],
) {
  if (deals.length > 100) throw new Error("DEAL_BATCH_LIMIT_EXCEEDED");
  const identities = new Set<string>();
  for (const deal of deals) {
    if (!deal.providerId.trim() || !deal.externalId.trim() || !deal.title.trim()) {
      throw new Error("DEAL_REQUIRED_FIELDS_MISSING");
    }
    if (!deal.url.startsWith("https://")) throw new Error("DEAL_URL_MUST_USE_HTTPS");
    if (deal.currency !== "EUR") throw new Error("DEAL_CURRENCY_UNSUPPORTED");
    if (!Number.isSafeInteger(deal.purchasePriceMinor) || deal.purchasePriceMinor < 0) {
      throw new Error("DEAL_PURCHASE_PRICE_INVALID");
    }
    if (!Number.isFinite(Date.parse(deal.observedAt))) throw new Error("DEAL_OBSERVED_AT_INVALID");
    if (deal.totalCostCents < 0n) throw new Error("DEAL_TOTAL_COST_INVALID");
    if (identities.has(`${deal.providerId}:${deal.externalId}`)) {
      throw new Error("DEAL_DUPLICATE_IN_BATCH");
    }
    identities.add(`${deal.providerId}:${deal.externalId}`);
  }

  return prisma.$transaction(async (tx) => {
    const saved = [];
    for (const deal of deals) {
      const data = {
        title: deal.title,
        productUrl: deal.url,
        currency: deal.currency,
        purchasePriceMinor: BigInt(deal.purchasePriceMinor),
        observedAt: new Date(deal.observedAt),
        simulated: deal.simulated,
        totalCostCents: deal.totalCostCents,
        expectedProfitCents: deal.expectedProfitCents,
        roiBasisPoints: deal.roiBasisPoints,
        riskPassed: deal.approvedByRiskRules,
        riskReasons: deal.riskReasons as Prisma.InputJsonValue,
        reviewStatus: "DISCOVERED" as const,
        reviewedBy: null,
        reviewedAt: null,
      };
      saved.push(await tx.dealCandidate.upsert({
        where: { providerId_externalId: { providerId: deal.providerId, externalId: deal.externalId } },
        create: {
          providerId: deal.providerId,
          externalId: deal.externalId,
          ...data,
        },
        update: data,
      }));
    }
    return saved;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function listDealCandidates(
  prisma: PrismaClient,
  options: DealCandidateListOptions = {},
) {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("DEAL_LIST_LIMIT_INVALID");
  }
  return prisma.dealCandidate.findMany({
    where: {
      ...(options.reviewStatus ? { reviewStatus: options.reviewStatus } : {}),
      ...(options.riskPassed === undefined ? {} : { riskPassed: options.riskPassed }),
    },
    orderBy: [{ expectedProfitCents: "desc" }, { observedAt: "desc" }],
    take: limit,
  });
}

/**
 * Internal review primitive. Must only be called after authenticated ADMIN
 * authorization. Approval is a review label, never a purchase instruction.
 */
export async function reviewDealCandidate(
  prisma: PrismaClient,
  input: { dealId: string; reviewerId: string; decision: "APPROVED" | "REJECTED" | "ARCHIVED" },
) {
  if (!input.dealId.trim() || !input.reviewerId.trim()) throw new Error("DEAL_REVIEW_FIELDS_REQUIRED");
  const current = await prisma.dealCandidate.findUnique({ where: { id: input.dealId } });
  if (!current) throw new Error("DEAL_CANDIDATE_NOT_FOUND");
  if (input.decision === "APPROVED" && (current.simulated || !current.riskPassed)) {
    throw new Error("DEAL_NOT_ELIGIBLE_FOR_REVIEW_APPROVAL");
  }
  const changed = await prisma.dealCandidate.updateMany({
    where: {
      id: input.dealId,
      reviewStatus: "DISCOVERED",
      updatedAt: current.updatedAt,
    },
    data: {
      reviewStatus: input.decision,
      reviewedBy: input.reviewerId,
      reviewedAt: new Date(),
    },
  });
  if (changed.count !== 1) throw new Error("DEAL_REVIEW_CONFLICT");
  return prisma.dealCandidate.findUniqueOrThrow({ where: { id: input.dealId } });
}
