import {
  ProviderCapabilityError,
  type ProviderAdapter,
  type ProviderCapability,
} from "./types.js";

export class DuplicateProviderError extends Error {
  constructor(providerId: string) {
    super(`Provider "${providerId}" is already registered`);
    this.name = "DuplicateProviderError";
  }
}

export class UnknownProviderError extends Error {
  constructor(providerId: string) {
    super(`Provider "${providerId}" is not registered`);
    this.name = "UnknownProviderError";
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    if (!ID_PATTERN.test(adapter.providerId)) {
      throw new Error("Provider IDs must be 2-64 lowercase URL-safe characters");
    }
    if (this.adapters.has(adapter.providerId)) {
      throw new DuplicateProviderError(adapter.providerId);
    }
    if (!adapter.displayName.trim()) {
      throw new Error("Provider displayName must not be empty");
    }

    const declared = new Set(adapter.capabilities);
    if (declared.size !== adapter.capabilities.length) {
      throw new Error("Provider capabilities must not contain duplicates");
    }

    for (const capability of declared) {
      if (!this.hasImplementation(adapter, capability)) {
        throw new Error(
          `Provider "${adapter.providerId}" declares ${capability} without implementing it`,
        );
      }
    }
    this.adapters.set(adapter.providerId, adapter);
  }

  get(providerId: string): ProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new UnknownProviderError(providerId);
    return adapter;
  }

  getForCapability(
    providerId: string,
    capability: ProviderCapability,
  ): ProviderAdapter {
    const adapter = this.get(providerId);
    if (!adapter.capabilities.includes(capability)) {
      throw new ProviderCapabilityError(providerId, capability);
    }
    return adapter;
  }

  list(): readonly Pick<
    ProviderAdapter,
    "providerId" | "displayName" | "capabilities" | "simulated"
  >[] {
    return [...this.adapters.values()].map(
      ({ providerId, displayName, capabilities, simulated }) => ({
        providerId,
        displayName,
        capabilities: [...capabilities],
        simulated,
      }),
    );
  }

  private hasImplementation(
    adapter: ProviderAdapter,
    capability: ProviderCapability,
  ): boolean {
    switch (capability) {
      case "PRODUCT_SEARCH":
        return typeof adapter.searchProducts === "function";
      case "PRICE_LOOKUP":
        return typeof adapter.getPrice === "function";
      case "STOCK_LOOKUP":
        return typeof adapter.getStock === "function";
    }
  }
}
