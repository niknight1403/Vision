export interface ProviderHttpClientOptions {
  /** HTTPS base URL supplied by trusted server configuration, never by a user. */
  baseUrl: string;
  /** Exact hostnames approved for this provider; wildcards are not supported. */
  allowedHosts: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Server-side secret only. Never pass a mobile/client-provided token. */
  bearerToken?: string;
}

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

function validateBaseUrl(baseUrl: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProviderHttpError("Provider base URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !allowedHosts.includes(url.hostname.toLowerCase())
  ) {
    throw new ProviderHttpError("Provider base URL is not allowlisted HTTPS");
  }
  return url;
}

/**
 * Small JSON-only outbound client. Redirects are rejected to prevent a trusted
 * provider endpoint from redirecting requests or credentials to another host.
 */
export class ProviderHttpClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: ProviderHttpClientOptions) {
    this.baseUrl = validateBaseUrl(options.baseUrl, options.allowedHosts);
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new Error("timeoutMs must be an integer between 1 and 60000");
    }
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new Error("maxResponseBytes must be a positive integer");
    }
  }

  async getJson<T>(
    path: string,
    query: Readonly<Record<string, string>> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const basePath = this.baseUrl.pathname.endsWith("/")
      ? this.baseUrl.pathname
      : this.baseUrl.pathname + "/";
    const allowedExactPath = basePath.slice(0, -1);
    if (
      url.origin !== this.baseUrl.origin ||
      (url.pathname !== allowedExactPath && !url.pathname.startsWith(basePath))
    ) {
      throw new ProviderHttpError("Provider request path escaped the configured base URL");
    }
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });

    const timeout = setTimeout(
      () => controller.abort(new Error("Provider request timed out")),
      this.timeoutMs,
    );

    try {
      const headers: Record<string, string> = {
        accept: "application/json",
      };
      if (this.options.bearerToken) {
        headers.authorization = `Bearer ${this.options.bearerToken}`;
      }
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        throw new ProviderHttpError(
          `Provider returned HTTP ${response.status}`,
          response.status,
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        throw new ProviderHttpError("Provider response was not JSON");
      }
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > this.maxResponseBytes) {
        throw new ProviderHttpError("Provider response exceeded the configured size limit");
      }
      if (!response.body) {
        throw new ProviderHttpError("Provider response body was empty");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let receivedBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedBytes += value.byteLength;
          if (receivedBytes > this.maxResponseBytes) {
            await reader.cancel();
            throw new ProviderHttpError("Provider response exceeded the configured size limit");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(receivedBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const body = new TextDecoder().decode(bytes);
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new ProviderHttpError("Provider returned malformed JSON");
      }
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      if (controller.signal.aborted) {
        throw new ProviderHttpError("Provider request was aborted or timed out");
      }
      throw new ProviderHttpError("Provider request failed");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
