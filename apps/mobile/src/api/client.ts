/**
 * Device-independent HTTP client for the AutonomAgent API.
 *
 * No React, no React Native, no Expo import: the module only needs `fetch`
 * (injectable), a `Scheduler` (injectable) and `AbortController`. That makes
 * the whole layer unit-testable in plain Node.
 *
 * Error policy:
 *  - transport failures  -> NetworkError / TimeoutError (retryable)
 *  - 401                 -> one refresh attempt, then SessionExpiredError
 *  - 429                 -> RateLimitedError with `retryAfterMs`
 *  - 5xx                 -> bounded retry, then ServerError
 *  - 2xx with bad JSON   -> InvalidJsonError
 * Messages never contain URLs, tokens, headers or payloads.
 */

import { computeBackoffDelay, DEFAULT_BACKOFF } from "./backoff";
import {
  AbortedError,
  ApiError,
  ClientError,
  InvalidJsonError,
  NetworkError,
  RateLimitedError,
  safeErrorCode,
  ServerError,
  SessionExpiredError,
  TimeoutError,
  UnauthorizedError,
} from "./errors";
import { realScheduler, type Scheduler } from "./scheduler";
import { SessionStore } from "./session";
import type {
  AuthTokenPair,
  Deal,
  EnqueuedAnalysis,
  OperationsOverview,
  TreasureAnalysisTask,
} from "./types";

export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<HttpResponseLike>;

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  scheduler?: Scheduler;
  /** Per-request timeout, aborting the underlying fetch. Default 15s. */
  timeoutMs?: number;
  /** Retries for idempotent requests on 5xx/network errors. Default 2. */
  maxRetries?: number;
  /** Upper bound applied to a server-provided Retry-After. Default 60s. */
  maxRetryAfterMs?: number;
  /** Jitter source, injectable for deterministic tests. */
  random?: () => number;
  /** Idempotency key factory for POSTs, injectable for deterministic tests. */
  idempotencyKeyFactory?: (prefix: string) => string;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  body?: unknown;
  /** Default true: sends the bearer token and handles 401 + refresh. */
  auth?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Overrides the automatic retry decision (GET/HEAD retry, writes do not). */
  retry?: boolean;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, parsed - nowMs);
}

function isAbortLike(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return base + suffix;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly scheduler: Scheduler;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly random: () => number;
  private readonly idempotencyKeyFactory: (prefix: string) => string;
  readonly session: SessionStore;

  constructor(options: ApiClientOptions) {
    if (!options.baseUrl || typeof options.baseUrl !== "string") {
      throw new Error("API_BASE_URL_REQUIRED");
    }
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<HttpResponseLike>);
    this.scheduler = options.scheduler ?? realScheduler;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
    this.random = options.random ?? Math.random;
    this.idempotencyKeyFactory =
      options.idempotencyKeyFactory ??
      ((prefix) =>
        `${prefix}-${this.scheduler.now()}-${Math.floor(this.random() * 1e9).toString(36)}`);
    this.session = new SessionStore((refreshToken) => this.refreshWithToken(refreshToken));
  }

  get isAuthenticated(): boolean {
    return this.session.isAuthenticated;
  }

  // ---------------------------------------------------------------- auth ---

  async login(email: string, password: string): Promise<AuthTokenPair> {
    const tokens = await this.request<AuthTokenPair>("/v1/auth/login", {
      method: "POST",
      auth: false,
      body: { email, password },
      retry: false,
    });
    this.session.set(tokens);
    return tokens;
  }

  /**
   * One refresh attempt against /v1/auth/refresh. Exposed for callers that want
   * to refresh proactively; requests do it themselves on 401.
   */
  async refreshSession(): Promise<AuthTokenPair> {
    return this.session.refresh();
  }

  /**
   * Local logout is immediate (the UI must never wait for the network), the
   * server-side revoke is best effort and cannot sign the user back in.
   */
  async logout(): Promise<void> {
    const refreshToken = this.session.refreshToken;
    this.session.clear();
    if (!refreshToken) return;
    try {
      await this.request<void>("/v1/auth/logout", {
        method: "POST",
        auth: false,
        body: { refreshToken },
        retry: false,
      });
    } catch {
      // Revocation failures must not keep the user signed in on this device.
    }
  }

  // --------------------------------------------------------------- reads ---

  async listDeals(options: { limit?: number; signal?: AbortSignal } = {}): Promise<Deal[]> {
    const query = options.limit === undefined ? "" : `?limit=${encodeURIComponent(String(options.limit))}`;
    const body = await this.request<{ deals: Deal[] }>(`/v1/deals${query}`, {
      signal: options.signal,
    });
    return body.deals ?? [];
  }

  async getTreasureAnalysis(taskId: string, options: { signal?: AbortSignal } = {}): Promise<TreasureAnalysisTask> {
    return this.request<TreasureAnalysisTask>(
      `/v1/treasure-analyses/${encodeURIComponent(taskId)}`,
      { signal: options.signal },
    );
  }

  async getOperationsOverview(options: { signal?: AbortSignal } = {}): Promise<OperationsOverview> {
    return this.request<OperationsOverview>("/v1/operations/overview", { signal: options.signal });
  }

  // -------------------------------------------------------------- writes ---

  async startTreasureAnalysis(
    dealId: string,
    imageUrl: string,
    options: { signal?: AbortSignal; idempotencyKey?: string } = {},
  ): Promise<EnqueuedAnalysis> {
    return this.request<EnqueuedAnalysis>(
      `/v1/deals/${encodeURIComponent(dealId)}/treasure-analysis`,
      {
        method: "POST",
        body: { imageUrl },
        signal: options.signal,
        idempotencyKey: options.idempotencyKey ?? this.idempotencyKeyFactory("mobile"),
        retry: false,
      },
    );
  }

  async requestVisionInspection(
    dealId: string,
    imageUrl: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ dealId: string; inspection: unknown; purchaseAuthorized: false; authenticityVerified: false }> {
    return this.request(
      `/v1/deals/${encodeURIComponent(dealId)}/vision-inspection`,
      { method: "POST", body: { imageUrl }, signal: options.signal, retry: false },
    );
  }

  // ------------------------------------------------------------ internals ---

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.execute<T>(path, options, true);
  }

  private async execute<T>(path: string, options: RequestOptions, mayRefresh: boolean): Promise<T> {
    try {
      return await this.send<T>(path, options);
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || options.auth === false) throw error;
      if (!mayRefresh) {
        // The freshly refreshed token was rejected as well: stop here.
        this.session.clear();
        throw new SessionExpiredError({ cause: error });
      }
      await this.refreshOrExpire(error);
      return this.execute<T>(path, options, false);
    }
  }

  private async refreshOrExpire(original: UnauthorizedError): Promise<void> {
    try {
      await this.session.refresh();
    } catch (error) {
      // Transport trouble while refreshing is not proof of an expired session:
      // keep the tokens so the next attempt can retry, and let the caller see
      // the real (offline/timeout) condition.
      if (error instanceof NetworkError || error instanceof TimeoutError || error instanceof AbortedError) {
        throw error;
      }
      this.session.clear();
      throw new SessionExpiredError({
        code: error instanceof ApiError ? error.code : undefined,
        cause: error ?? original,
      });
    }
  }

  private async refreshWithToken(refreshToken: string): Promise<AuthTokenPair> {
    const tokens = await this.request<AuthTokenPair>("/v1/auth/refresh", {
      method: "POST",
      auth: false,
      body: { refreshToken },
      retry: false,
    });
    if (!tokens || typeof tokens.accessToken !== "string" || !tokens.accessToken) {
      throw new SessionExpiredError({ code: "TOKEN_RESPONSE_INVALID" });
    }
    return tokens;
  }

  private async send<T>(path: string, options: RequestOptions): Promise<T> {
    const method = options.method ?? "GET";
    const retryAllowed = options.retry ?? (method === "GET" || method === "HEAD");
    const maxAttempts = retryAllowed ? this.maxRetries + 1 : 1;
    let lastError: ApiError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.sendOnce<T>(path, options, method);
      } catch (error) {
        lastError = this.normalizeError(error);
        if (!lastError.retryable || attempt >= maxAttempts) throw lastError;
        const delay = computeBackoffDelay(attempt, {
          ...DEFAULT_BACKOFF,
          random: this.random,
        });
        await this.scheduler.sleep(delay, options.signal);
      }
    }
    throw lastError ?? new NetworkError();
  }

  private normalizeError(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    if (isAbortLike(error)) return new AbortedError({ cause: error });
    return new NetworkError({ cause: error });
  }

  private async sendOnce<T>(path: string, options: RequestOptions, method: string): Promise<T> {
    const url = joinUrl(this.baseUrl, path);
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    let externalAborted = false;

    const onExternalAbort = () => {
      externalAborted = true;
      controller.abort();
    };
    if (options.signal) {
      if (options.signal.aborted) throw new AbortedError();
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer = this.scheduler.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const headers: Record<string, string> = { accept: "application/json", ...options.headers };
      if (options.body !== undefined) headers["content-type"] = "application/json";
      if (options.auth !== false) {
        const token = this.session.accessToken;
        if (!token) throw new SessionExpiredError();
        headers.authorization = `Bearer ${token}`;
      }
      if (options.idempotencyKey) headers["x-idempotency-key"] = options.idempotencyKey;

      let response: HttpResponseLike;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) throw new TimeoutError({ cause: error });
        if (externalAborted || isAbortLike(error)) throw new AbortedError({ cause: error });
        throw new NetworkError({ cause: error });
      }

      if (timedOut) throw new TimeoutError();
      const rawBody = await this.readBody(response);
      if (!response.ok) throw this.errorFromResponse(response, rawBody);
      if (response.status === 204 || rawBody === "") return undefined as T;
      try {
        return JSON.parse(rawBody) as T;
      } catch (error) {
        throw new InvalidJsonError({ status: response.status, cause: error });
      }
    } finally {
      this.scheduler.clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async readBody(response: HttpResponseLike): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  private errorFromResponse(response: HttpResponseLike, rawBody: string): ApiError {
    const status = response.status;
    const code = this.errorCodeFromBody(rawBody);
    if (status === 401) {
      return new UnauthorizedError({ code, status });
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), this.scheduler.now());
      return new RateLimitedError({
        code,
        status,
        retryAfterMs:
          retryAfterMs === undefined ? undefined : Math.min(retryAfterMs, this.maxRetryAfterMs),
      });
    }
    if (status >= 500) {
      return new ServerError({ code, status });
    }
    return new ClientError({ code, status });
  }

  private errorCodeFromBody(rawBody: string): string | undefined {
    if (!rawBody) return undefined;
    try {
      const parsed = JSON.parse(rawBody) as { error?: unknown; detail?: unknown };
      return safeErrorCode(parsed.error) ?? safeErrorCode(parsed.detail);
    } catch {
      return undefined;
    }
  }
}
