import { loadProviderRuntimeConfig } from "./provider-config.js";
import { CatalogRestAdapter } from "./catalog-rest-adapter.js";
import { ProviderRegistry } from "./registry.js";

/**
 * Builds the read-only provider registry from trusted server environment.
 * The API currently does not expose this registry through public routes.
 */
export function createConfiguredProviderRegistry(
  env: NodeJS.ProcessEnv = process.env,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  const catalogConfig = loadProviderRuntimeConfig("catalog-demo", env);
  if (catalogConfig.enabled) {
    registry.register(new CatalogRestAdapter(catalogConfig, "Configured catalog provider"));
  }
  return registry;
}
