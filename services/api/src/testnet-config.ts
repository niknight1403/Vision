export type TestnetRuntimeConfig = {
  enabled: boolean;
  environment: "TESTNET";
  configVersion: string;
  providerId: string | null;
  accountId: string | null;
  apiVersion: string | null;
  baseUrl: string;
  allowedHosts: readonly string[];
  blockedProductionHosts: readonly string[];
};

const DISABLED_BASE_URL = "https://disabled.invalid/";
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const VERSION = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false`);
}

function exactHosts(value: string | undefined, name: string, required: boolean): string[] {
  if (!value?.trim()) {
    if (required) throw new Error(`${name} is required`);
    return [];
  }
  const hosts = [...new Set(value.split(",").map((item) => item.trim().toLowerCase()))];
  if (hosts.some((host) => !HOST.test(host) || host.includes("*") || host.includes("/") || host.includes(":"))) {
    throw new Error(`${name} must contain exact hostnames only`);
  }
  return hosts;
}

function requiredValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Read only trusted API-process environment. This validates identity and host
 * binding but never performs a network call and never enables the API's
 * production/live mode. Secrets belong to a separate secret-manager layer.
 */
export function loadTestnetRuntimeConfig(env: NodeJS.ProcessEnv = process.env): TestnetRuntimeConfig {
  const enabled = parseBoolean(env.TESTNET_ENABLED, "TESTNET_ENABLED");
  if (!enabled) {
    return { enabled: false, environment: "TESTNET", configVersion: "v0.0.0", providerId: null, accountId: null, apiVersion: null, baseUrl: DISABLED_BASE_URL, allowedHosts: [], blockedProductionHosts: [] };
  }

  const environment = requiredValue(env, "TESTNET_ENVIRONMENT");
  if (environment !== "TESTNET") throw new Error("TESTNET_ENVIRONMENT must be TESTNET");
  const configVersion = requiredValue(env, "TESTNET_CONFIG_VERSION");
  if (!VERSION.test(configVersion)) throw new Error("TESTNET_CONFIG_VERSION must use semantic vMAJOR.MINOR.PATCH format");
  const providerId = requiredValue(env, "TESTNET_PROVIDER_ID");
  if (!PROVIDER_ID.test(providerId)) throw new Error("TESTNET_PROVIDER_ID is invalid");
  const accountId = requiredValue(env, "TESTNET_ACCOUNT_ID");
  if (accountId.length > 128 || /[\r\n]/.test(accountId)) throw new Error("TESTNET_ACCOUNT_ID is invalid");
  const apiVersion = requiredValue(env, "TESTNET_API_VERSION");
  if (apiVersion.length > 64 || /[\r\n]/.test(apiVersion)) throw new Error("TESTNET_API_VERSION is invalid");
  const baseUrl = requiredValue(env, "TESTNET_BASE_URL");
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error("TESTNET_BASE_URL must be a valid URL"); }
  const allowedHosts = exactHosts(env.TESTNET_ALLOWED_HOSTS, "TESTNET_ALLOWED_HOSTS", true);
  const blockedProductionHosts = exactHosts(env.TESTNET_BLOCKED_PRODUCTION_HOSTS, "TESTNET_BLOCKED_PRODUCTION_HOSTS", true);
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !allowedHosts.includes(hostname)) throw new Error("TESTNET_BASE_URL must use HTTPS and an exact allowlisted hostname without credentials, query, or fragment");
  if (blockedProductionHosts.includes(hostname) || allowedHosts.some((host) => blockedProductionHosts.includes(host))) throw new Error("TESTNET production and allowed host lists overlap");

  return { enabled: true, environment: "TESTNET", configVersion, providerId, accountId, apiVersion, baseUrl: parsed.toString(), allowedHosts, blockedProductionHosts };
}
