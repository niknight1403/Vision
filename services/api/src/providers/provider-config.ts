import type { ProviderHttpClientOptions } from "./http-client.js";

export interface ProviderRuntimeConfig extends ProviderHttpClientOptions {
  providerId: string;
  enabled: boolean;
}

/**
 * Reads trusted server-process environment only. Do not pass request bodies or
 * mobile-provided values here. Provider IDs are application configuration.
 */
export function loadProviderRuntimeConfig(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderRuntimeConfig {
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(providerId)) {
    throw new Error("Invalid provider configuration ID");
  }

  const prefix = `PROVIDER_${providerId.toUpperCase().replace(/-/g, "_")}`;
  const baseUrl = env[`${prefix}_BASE_URL`];
  const rawHosts = env[`${prefix}_ALLOWED_HOSTS`];
  const bearerToken = env[`${prefix}_API_TOKEN`];

  if (!baseUrl && !rawHosts && !bearerToken) {
    return {
      providerId,
      enabled: false,
      baseUrl: "https://disabled.invalid/",
      allowedHosts: [],
    };
  }
  if (!baseUrl || !rawHosts) {
    throw new Error(`${prefix}_BASE_URL and ${prefix}_ALLOWED_HOSTS must be configured together`);
  }

  const allowedHosts = [...new Set(rawHosts.split(",").map((host) => host.trim().toLowerCase()))];
  if (allowedHosts.length === 0 || allowedHosts.some((host) =>
    !host || host.includes("*") || host.includes("/") || host.includes(":")
  )) {
    throw new Error(`${prefix}_ALLOWED_HOSTS must contain exact hostnames only`);
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`${prefix}_BASE_URL must be a valid URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !allowedHosts.includes(parsed.hostname.toLowerCase())
  ) {
    throw new Error(`${prefix}_BASE_URL must use HTTPS and an exact allowlisted hostname`);
  }
  if (bearerToken !== undefined && (bearerToken.length < 8 || /\s/.test(bearerToken))) {
    throw new Error(`${prefix}_API_TOKEN must be a non-empty opaque token`);
  }

  return {
    providerId,
    enabled: true,
    baseUrl: parsed.toString(),
    allowedHosts,
    ...(bearerToken ? { bearerToken } : {}),
    timeoutMs: 8_000,
    maxResponseBytes: 1_000_000,
  };
}
