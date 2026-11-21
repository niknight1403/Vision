import { loadProviderRuntimeConfig } from "./provider-config.js";
import { CatalogRestAdapter } from "./catalog-rest-adapter.js";
import { ProviderRegistry } from "./registry.js";

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
  return registry;
}
