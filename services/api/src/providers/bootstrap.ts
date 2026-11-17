import { loadProviderRuntimeConfig } from "./provider-config.js";
import { CatalogRestAdapter } from "./catalog-rest-adapter.js";
import { EbayBrowseAdapter, loadEbayBrowseConfig } from "./ebay-browse-adapter.js";
import { ProviderRegistry } from "./registry.js";

/**
 * Builds the read-only provider registry from trusted server environment.
 * Only explicitly configured adapters are registered; no write capabilities exist.
 */
export function createConfiguredProviderRegistry(
  env: NodeJS.ProcessEnv = process.env,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  const catalogConfig = loadProviderRuntimeConfig("catalog-demo", env);
  if (catalogConfig.enabled) {
    registry.register(new CatalogRestAdapter(catalogConfig, "Configured catalog provider"));
  }
  const ebayConfig = loadEbayBrowseConfig(env);
  if (ebayConfig) {
    registry.register(new EbayBrowseAdapter(ebayConfig));
  }
  return registry;
}
