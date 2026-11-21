import { describe, expect, it, vi } from "vitest";
import { runReadOnlyReconciliation } from "./reconciliation-service.js";
const internal = [{ intentId: "i", clientOrderId: "c", status: "SUBMITTED" as const, filledQuantity: 0n, feeCents: 0n, providerOrderId: "p" }];
const external = [{ clientOrderId: "c", providerOrderId: "p", status: "OPEN" as const, filledQuantity: 0n, averagePriceCents: null, feeCents: 0n }];
function db() { return { reconciliationRun: { create: vi.fn(async () => ({ id: "run-1" })), update: vi.fn(async () => ({})) } }; }
describe("read-only reconciliation", () => {
  it("starts and closes a clean run", async () => { const prisma = db(); const result = await runReadOnlyReconciliation(prisma, { providerId: "p", accountId: "a", internal, external }); expect(result.status).toBe("CLEAN"); expect(prisma.reconciliationRun.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CLEAN" }) })); });
  it("marks unknown external orders as halt-required without importing them", async () => { const prisma = db(); const result = await runReadOnlyReconciliation(prisma, { providerId: "p", accountId: "a", internal: [], external: [{ ...external[0]!, clientOrderId: "unknown" }] }); expect(result.status).toBe("HALT_REQUIRED"); expect(result.diffs[0]?.kind).toBe("UNMATCHED_EXTERNAL_ORDER"); });
});
