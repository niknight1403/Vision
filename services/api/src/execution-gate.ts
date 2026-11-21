export type FreshSnapshot = { observedAt: string; priceCents: bigint; stock: bigint; feeCents: bigint };
export type GateInput = { expected: FreshSnapshot; fresh: FreshSnapshot; maxPriceDriftCents: bigint; maxFeeDriftCents: bigint; requestedStock: bigint; clientOrderId: string; seenClientOrderIds: ReadonlySet<string> };
export function evaluateFreshExecutionGate(input: GateInput): { allowed: true } {
  if (!input.clientOrderId.trim()) throw new Error("CLIENT_ORDER_ID_REQUIRED");
  if (input.seenClientOrderIds.has(input.clientOrderId)) throw new Error("DUPLICATE_CLIENT_ORDER_ID");
  if (!Number.isFinite(Date.parse(input.fresh.observedAt)) || Date.parse(input.fresh.observedAt) <= Date.parse(input.expected.observedAt)) throw new Error("FRESH_SNAPSHOT_REQUIRED");
  if (input.fresh.priceCents < 0n || input.expected.priceCents < 0n || input.fresh.feeCents < 0n) throw new Error("SNAPSHOT_INVALID");
  if (input.fresh.priceCents > input.expected.priceCents + input.maxPriceDriftCents || input.fresh.priceCents + input.maxPriceDriftCents < input.expected.priceCents) throw new Error("PRICE_DRIFT_EXCEEDED");
  if (input.fresh.feeCents > input.expected.feeCents + input.maxFeeDriftCents) throw new Error("FEE_DRIFT_EXCEEDED");
  if (input.fresh.stock < input.requestedStock) throw new Error("STOCK_DRIFT_EXCEEDED");
  return { allowed: true };
}
