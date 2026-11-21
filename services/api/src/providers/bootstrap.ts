import { loadProviderRuntimeConfig } from "./provider-config.js";
import { CatalogRestAdapter } from "./catalog-rest-adapter.js";
import { ProviderRegistry } from "./registry.js";
import { StagingCatalogAdapter } from "./staging-catalog-adapter.js";

/**
 * Builds the real provider registry from trusted server environment.
 * No fixture or fallback provider is registered when configuration is absent.
 */
export function createConfiguredProviderRegistry(
  env: NodeJS.ProcessEnv = process.env,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  const catalogConfig = loadProviderRuntimeConfig("catalog-live", env);
  if (catalogConfig.enabled) {
    registry.register(new CatalogRestAdapter(catalogConfig, "Configured catalog provider"));
  }
  if (env.STAGING_PROVIDER_ENABLED === "true") {
    if (env.NODE_ENV !== "staging") {
      throw new Error("STAGING_PROVIDER_REQUIRES_STAGING_NODE_ENV");
    }
    if (env.STAGING_SYNTHETIC_DATA_ACK !== "I_UNDERSTAND_SYNTHETIC_DATA") {
      throw new Error("STAGING_SYNTHETIC_DATA_ACK_REQUIRED");
    }
    registry.register(new StagingCatalogAdapter());
  }
  return registry;
}
