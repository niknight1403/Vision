export type TestnetEnvironment = "TESTNET";
export type KillSwitchScope = "GLOBAL" | "PROVIDER" | "ACCOUNT" | "STRATEGY";
export type KillSwitchState = "ARMED" | "TRIGGERED" | "DRAINING" | "HALTED";
export type OrderStatus = "DRAFT" | "APPROVED" | "QUEUED" | "SUBMITTING" | "SUBMITTED" | "PARTIALLY_FILLED" | "FILLED" | "CANCEL_REQUESTED" | "CANCELLED" | "REJECTED" | "UNKNOWN";
export type ProviderCapability = "ACCOUNT_READ" | "BALANCE_READ" | "ORDER_SUBMIT" | "ORDER_STATUS" | "OPEN_ORDERS_READ" | "FILLS_READ" | "CANCEL_ORDER";

export type ApprovalSnapshot = {
  intentId: string;
  payloadHash: string;
  environment: TestnetEnvironment;
  providerId: string;
  accountId: string;
  instrument: string;
  side: "BUY" | "SELL";
  quantity: bigint;
  limitPriceCents: bigint;
  feeLimitCents: bigint;
  expiresAt: string;
  approvedBy: string;
};

export type OrderIntent = {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  environment: TestnetEnvironment;
  providerId: string;
  accountId: string;
  status: OrderStatus;
  approval: ApprovalSnapshot | null;
};

export type ProviderOrderSnapshot = {
  providerOrderId: string;
  clientOrderId: string;
  status: string;
  filledQuantity: bigint;
  averagePriceCents: bigint | null;
  feeCents: bigint;
};

export type JournalOrderSnapshot = {
  intentId: string;
  clientOrderId: string;
  status: OrderStatus;
  filledQuantity: bigint;
  feeCents: bigint;
  providerOrderId: string | null;
  instrument?: string;
  side?: "BUY" | "SELL";
  quantity?: bigint;
  priceCents?: bigint;
};

export type ReconciliationDiff = {
  kind: "UNKNOWN_INTERNAL_ORDER" | "UNMATCHED_EXTERNAL_ORDER" | "FILL_MISMATCH" | "FEE_MISMATCH" | "STATUS_MISMATCH" | "UNKNOWN_PROVIDER_STATUS" | "QUANTITY_MISMATCH" | "PRICE_MISMATCH";
  severity: "WARNING" | "CRITICAL";
  clientOrderId: string;
  detail: string;
};

export type ReconciliationResult = {
  status: "CLEAN" | "HALT_REQUIRED";
  diffs: readonly ReconciliationDiff[];
  externalOrdersSeen: number;
  internalOrdersSeen: number;
};

const TERMINAL: readonly OrderStatus[] = ["FILLED", "CANCELLED", "REJECTED"];
const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  DRAFT: ["APPROVED", "REJECTED"],
  APPROVED: ["QUEUED", "REJECTED", "UNKNOWN"],
  QUEUED: ["SUBMITTING", "CANCELLED", "UNKNOWN"],
  SUBMITTING: ["SUBMITTED", "REJECTED", "UNKNOWN"],
  SUBMITTED: ["PARTIALLY_FILLED", "FILLED", "CANCEL_REQUESTED", "REJECTED", "UNKNOWN"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "CANCEL_REQUESTED", "UNKNOWN"],
  FILLED: [],
  CANCEL_REQUESTED: ["CANCELLED", "PARTIALLY_FILLED", "FILLED", "UNKNOWN"],
  CANCELLED: [],
  REJECTED: [],
  UNKNOWN: ["SUBMITTED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "UNKNOWN"],
};

export function transitionOrderStatus(current: OrderStatus, next: OrderStatus): OrderStatus {
  if (!ALLOWED_TRANSITIONS[current].includes(next)) throw new Error(`ORDER_TRANSITION_NOT_ALLOWED:${current}:${next}`);
  return next;
}

export function validateApproval(snapshot: ApprovalSnapshot, now: string): void {
  if (snapshot.environment !== "TESTNET") throw new Error("TESTNET_ENVIRONMENT_REQUIRED");
  if (!snapshot.intentId.trim() || !snapshot.payloadHash.trim() || !snapshot.providerId.trim() || !snapshot.accountId.trim() || !snapshot.instrument.trim()) throw new Error("APPROVAL_FIELDS_REQUIRED");
  if (snapshot.quantity <= 0n || snapshot.limitPriceCents <= 0n || snapshot.feeLimitCents < 0n) throw new Error("APPROVAL_FINANCIAL_FIELDS_INVALID");
  if (!snapshot.approvedBy.trim() || !Number.isFinite(Date.parse(snapshot.expiresAt)) || Date.parse(snapshot.expiresAt) <= Date.parse(now)) throw new Error("APPROVAL_EXPIRED");
}

export function makeClientOrderId(environment: TestnetEnvironment, accountId: string, intentId: string, version = 1): string {
  if (!accountId.trim() || !intentId.trim() || !Number.isInteger(version) || version < 1) throw new Error("CLIENT_ORDER_ID_INPUT_INVALID");
  return `aa-${environment.toLowerCase()}-${accountId}-${intentId}-v${version}`;
}

export function evaluateKillSwitch(scopes: readonly { scope: KillSwitchScope; state: KillSwitchState }[]): { acceptsNewOrders: boolean; reason: string } {
  const blocking = scopes.find((item) => item.state !== "ARMED");
  return blocking ? { acceptsNewOrders: false, reason: `KILL_SWITCH_${blocking.scope}_${blocking.state}` } : { acceptsNewOrders: true, reason: "ALL_SCOPES_ARMED" };
}

/** Strict loader boundary: missing, duplicate, unknown, future-dated, or blocked scopes fail closed. */
export function validateKillSwitchScopes(
  scopes: readonly { scope: KillSwitchScope; state: KillSwitchState; updatedAt?: string }[],
  expectedScopes: readonly KillSwitchScope[] = ["GLOBAL", "PROVIDER", "ACCOUNT", "STRATEGY"],
  now = new Date().toISOString(),
): void {
  const expected = new Set(expectedScopes);
  if (expected.size !== expectedScopes.length || expected.size === 0 || scopes.length !== expected.size ||
      scopes.some((item) => !expected.has(item.scope)) || new Set(scopes.map((item) => item.scope)).size !== scopes.length) {
    throw new Error("KILL_SWITCH_SCOPE_SET_INVALID");
  }
  for (const item of scopes) {
    if (item.updatedAt !== undefined && (!Number.isFinite(Date.parse(item.updatedAt)) || Date.parse(item.updatedAt) > Date.parse(now))) {
      throw new Error("KILL_SWITCH_SCOPE_TIMESTAMP_INVALID");
    }
    if (item.state !== "ARMED") throw new Error(`KILL_SWITCH_${item.scope}_${item.state}`);
  }
}

export function evaluateExecutionGate(input: { intent: OrderIntent; capabilities: readonly ProviderCapability[]; killSwitches: readonly { scope: KillSwitchScope; state: KillSwitchState }[]; now: string; emergencyStop: boolean }): { allowed: true } {
  if (input.emergencyStop) throw new Error("EMERGENCY_STOP_ACTIVE");
  if (input.intent.environment !== "TESTNET") throw new Error("TESTNET_ENVIRONMENT_REQUIRED");
  if (input.intent.status !== "APPROVED" && input.intent.status !== "QUEUED") throw new Error("ORDER_NOT_APPROVED");
  if (!input.intent.approval) throw new Error("APPROVAL_SNAPSHOT_REQUIRED");
  validateApproval(input.intent.approval, input.now);
  const kill = evaluateKillSwitch(input.killSwitches);
  if (!kill.acceptsNewOrders) throw new Error(kill.reason);
  if (!input.capabilities.includes("ORDER_SUBMIT")) throw new Error("PROVIDER_ORDER_SUBMIT_UNAVAILABLE");
  return { allowed: true };
}

export interface TestnetProviderAdapter {
  readonly providerId: string;
  readonly environment: TestnetEnvironment;
  readonly capabilities: readonly ProviderCapability[];
  submitOrder(_request: { clientOrderId: string; instrument: string; side: "BUY" | "SELL"; quantity: bigint; limitPriceCents: bigint }): Promise<never>;
  queryOrders(_clientOrderIds: readonly string[]): Promise<readonly ProviderOrderSnapshot[]>;
}

/** Default adapter: safe placeholder until a reviewed provider implementation is installed. */
export class DisabledTestnetAdapter implements TestnetProviderAdapter {
  readonly environment = "TESTNET" as const;
  readonly capabilities: readonly ProviderCapability[] = [];
  constructor(public readonly providerId = "disabled-testnet") {}
  async submitOrder(_request: { clientOrderId: string; instrument: string; side: "BUY" | "SELL"; quantity: bigint; limitPriceCents: bigint }): Promise<never> { throw new Error("TESTNET_ADAPTER_DISABLED"); }
  async queryOrders(_clientOrderIds: readonly string[]): Promise<readonly ProviderOrderSnapshot[]> { throw new Error("TESTNET_ADAPTER_DISABLED"); }
}

export function reconcileOrders(internal: readonly JournalOrderSnapshot[], external: readonly ProviderOrderSnapshot[]): ReconciliationResult {
  const externalByClient = new Map(external.map((order) => [order.clientOrderId, order]));
  const internalByClient = new Map(internal.map((order) => [order.clientOrderId, order]));
  const diffs: ReconciliationDiff[] = [];
  for (const order of internal) {
    const provider = externalByClient.get(order.clientOrderId);
    if (!provider) {
      if (!TERMINAL.includes(order.status)) diffs.push({ kind: "UNKNOWN_INTERNAL_ORDER", severity: "CRITICAL", clientOrderId: order.clientOrderId, detail: "Interne nicht-terminale Order fehlt beim Provider" });
      continue;
    }
    if (order.providerOrderId && order.providerOrderId !== provider.providerOrderId) diffs.push({ kind: "STATUS_MISMATCH", severity: "CRITICAL", clientOrderId: order.clientOrderId, detail: "Provider-Order-ID stimmt nicht überein" });
    if (!["OPEN", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED"].includes(provider.status)) diffs.push({ kind: "UNKNOWN_PROVIDER_STATUS", severity: "CRITICAL", clientOrderId: order.clientOrderId, detail: "Unbekannter Rohstatus erfordert Halt" });
    if (provider.filledQuantity < order.filledQuantity) diffs.push({ kind: "FILL_MISMATCH", severity: "CRITICAL", clientOrderId: order.clientOrderId, detail: "Provider-Fill liegt unter internem Fill" });
    if (order.quantity !== undefined && provider.filledQuantity > order.quantity) diffs.push({ kind: "QUANTITY_MISMATCH", severity: "CRITICAL", clientOrderId: order.clientOrderId, detail: "Provider-Menge überschreitet interne Obergrenze" });
    if (provider.feeCents !== order.feeCents) diffs.push({ kind: "FEE_MISMATCH", severity: "WARNING", clientOrderId: order.clientOrderId, detail: "Gebührenabweichung muss als Ledger-Event geklärt werden" });
  }
  for (const order of external) if (!internalByClient.has(order.clientOrderId)) diffs.push({ kind: "UNMATCHED_EXTERNAL_ORDER", severity: "CRITICAL", clientOrderId: order.clientOrderId, detail: "Externe Order ist im internen Journal unbekannt" });
  return { status: diffs.some((diff) => diff.severity === "CRITICAL") ? "HALT_REQUIRED" : "CLEAN", diffs, externalOrdersSeen: external.length, internalOrdersSeen: internal.length };
}
