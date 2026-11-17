export type TestnetReadOnlyCapability = "HEALTH_READ" | "INSTRUMENTS_READ" | "BALANCE_READ" | "OPEN_ORDERS_READ" | "ORDER_STATUS_READ" | "FILLS_READ";

export type TestnetProviderHealth = { status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN"; checkedAt: string; latencyMs?: number };
export type TestnetBalance = { asset: string; availableMinor: bigint; lockedMinor: bigint };
export type TestnetOrder = { clientOrderId: string; providerOrderId: string; status: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED"; filledQuantity: bigint };
export type TestnetFill = { providerFillId: string; providerOrderId: string; quantity: bigint; priceMinor: bigint; feeMinor: bigint };

export type TestnetReadOnlyAdapter = {
  providerId: string;
  environment: "TESTNET";
  capabilities: readonly TestnetReadOnlyCapability[];
  healthCheck(): Promise<TestnetProviderHealth>;
  getInstruments?(): Promise<readonly string[]>;
  getBalances?(): Promise<readonly TestnetBalance[]>;
  getOpenOrders?(): Promise<readonly TestnetOrder[]>;
  getOrderStatus?(clientOrderId: string): Promise<TestnetOrder | null>;
  getFills?(from: string, to: string): Promise<readonly TestnetFill[]>;
};

const IMPLEMENTATIONS: Readonly<Record<TestnetReadOnlyCapability, keyof TestnetReadOnlyAdapter>> = {
  HEALTH_READ: "healthCheck",
  INSTRUMENTS_READ: "getInstruments",
  BALANCE_READ: "getBalances",
  OPEN_ORDERS_READ: "getOpenOrders",
  ORDER_STATUS_READ: "getOrderStatus",
  FILLS_READ: "getFills",
};

export function validateTestnetReadOnlyAdapter(adapter: TestnetReadOnlyAdapter): void {
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(adapter.providerId)) throw new Error("TESTNET_PROVIDER_ID_INVALID");
  if (adapter.environment !== "TESTNET") throw new Error("TESTNET_ADAPTER_ENVIRONMENT_INVALID");
  const unique = new Set(adapter.capabilities);
  if (unique.size !== adapter.capabilities.length) throw new Error("TESTNET_CAPABILITIES_DUPLICATE");
  for (const capability of adapter.capabilities) {
    if (!(capability in IMPLEMENTATIONS)) throw new Error("TESTNET_CAPABILITY_UNSUPPORTED");
    if (typeof adapter[IMPLEMENTATIONS[capability]] !== "function") throw new Error(`TESTNET_CAPABILITY_NOT_IMPLEMENTED:${capability}`);
  }
}

export function assertReadOnlyTestnetCapabilities(capabilities: readonly TestnetReadOnlyCapability[]): void {
  if (capabilities.some((capability) => capability.includes("SUBMIT") || capability.includes("CANCEL") || capability.includes("WITHDRAW"))) throw new Error("TESTNET_MUTATION_CAPABILITY_FORBIDDEN");
}
