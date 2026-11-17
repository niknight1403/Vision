import type { PrismaClient } from "@prisma/client";
import {
  scanProviderDeals,
  type ProviderDealScanRequest,
} from "@autonomagent/trading-core";
import { persistDealCandidates } from "./deal-candidate-service.js";
import type { ProviderRegistry } from "./providers/registry.js";

/**
 * Runs one explicitly requested, read-only scan and persists its analysis.
 * This is an internal service boundary; it is deliberately not wired to an
 * unauthenticated HTTP route or a background scheduler.
 */
export async function runAndPersistDealScan(
  dependencies: {
    prisma: PrismaClient;
    providers: ProviderRegistry;
  },
  input: ProviderDealScanRequest & { providerId: string },
  signal?: AbortSignal,
) {
  const provider = dependencies.providers.getForCapability(
    input.providerId,
    "PRODUCT_SEARCH",
  );

  const analyses = await scanProviderDeals(provider, input, signal);
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Deal scan aborted before persistence");
  }

  const persisted = await persistDealCandidates(dependencies.prisma, analyses);
  return {
    providerId: provider.providerId,
    providerSimulated: provider.simulated,
    scannedCount: analyses.length,
    persistedCount: persisted.length,
    riskPassedCount: analyses.filter((deal) => deal.approvedByRiskRules).length,
    simulatedCount: analyses.filter((deal) => deal.simulated).length,
  };
}
