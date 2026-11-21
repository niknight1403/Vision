import { reconcileOrders, type JournalOrderSnapshot, type ProviderOrderSnapshot, type ReconciliationResult } from "./testnet-execution.js";
type ReconciliationStore = { reconciliationRun: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }>; update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown> } };
export async function runReadOnlyReconciliation(prisma: ReconciliationStore, input: { providerId: string; accountId: string; internal: readonly JournalOrderSnapshot[]; external: readonly ProviderOrderSnapshot[] }): Promise<ReconciliationResult & { runId: string }> {
  const run = await prisma.reconciliationRun.create({ data: { providerId: input.providerId, accountId: input.accountId, environment: "TESTNET", status: "RUNNING" } });
  try {
    const result = reconcileOrders(input.internal, input.external);
    await prisma.reconciliationRun.update({ where: { id: run.id }, data: { status: result.status, finishedAt: new Date(), diffSummary: { diffs: result.diffs, internalOrdersSeen: result.internalOrdersSeen, externalOrdersSeen: result.externalOrdersSeen } } });
    return { ...result, runId: run.id };
  } catch (error) {
    await prisma.reconciliationRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), diffSummary: { error: "RECONCILIATION_FAILED" } } });
    throw error;
  }
}
