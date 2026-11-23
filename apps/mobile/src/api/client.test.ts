import { describe, expect, it } from "vitest";

import { computeBackoffDelay, computeBackoffBase } from "./backoff";
import { ApiClient, parseRetryAfterMs, type FetchLike } from "./client";
import {
  AbortedError,
  ClientError,
  InvalidJsonError,
  NetworkError,
  RateLimitedError,
  ServerError,
  SessionExpiredError,
  TimeoutError,
  UnauthorizedError,
} from "./errors";
import { realScheduler } from "./scheduler";
import type { AuthTokenPair } from "./types";
import {
  authHeader,
  createFakeFetch,
  createFakeScheduler,
  jsonResponse,
} from "./test-support";

const BASE = "https://api.example.test";

const TOKENS_1: AuthTokenPair = {
  tokenType: "Bearer",
  accessToken: "access-token-1",
  accessTokenExpiresIn: 900,
  refreshToken: "refresh-token-1",
  refreshTokenExpiresAt: "2026-12-23T00:00:00.000Z",
};
const TOKENS_2: AuthTokenPair = {
  tokenType: "Bearer",
  accessToken: "access-token-2",
  accessTokenExpiresIn: 900,
  refreshToken: "refresh-token-2",
  refreshTokenExpiresAt: "2026-12-23T00:00:00.000Z",
};

function makeClient(handler: Parameters<typeof createFakeFetch>[0], overrides: {
  maxRetries?: number;
  timeoutMs?: number;
} = {}) {
  const fake = createFakeFetch(handler);
  const scheduler = createFakeScheduler();
  const client = new ApiClient({
    baseUrl: BASE,
    fetch: fake.fetch,
    scheduler,
    random: () => 0.5,
    maxRetries: overrides.maxRetries ?? 0,
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
  });
  return { client, calls: fake.calls, scheduler };
}

describe("ApiClient authentication", () => {
  it("logs in with email/password and stores the token pair", async () => {
    const { client, calls } = makeClient(() => jsonResponse(TOKENS_1));

    const tokens = await client.login("operator@example.test", "ein-sehr-langes-passwort");

    expect(tokens.accessToken).toBe("access-token-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/auth/login`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({
      email: "operator@example.test",
      password: "ein-sehr-langes-passwort",
    });
    expect(client.isAuthenticated).toBe(true);
    expect(client.session.accessToken).toBe("access-token-1");
  });

  it("sends the bearer token and query for GET /v1/deals", async () => {
    const { client, calls } = makeClient(() =>
      jsonResponse({ deals: [{ id: "deal-1", title: "Kamera" }] }),
    );
    client.session.set(TOKENS_1);

    const deals = await client.listDeals({ limit: 50 });

    expect(deals).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/deals?limit=50`);
    expect(authHeader(calls[0]!)).toBe("Bearer access-token-1");
  });

  it("fails with SessionExpiredError before any request when no token exists", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ deals: [] }));

    await expect(client.listDeals()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(calls).toHaveLength(0);
  });

  it("revokes on logout and clears the local session even when the call fails", async () => {
    const { client, calls } = makeClient(() => {
      throw new Error("socket closed");
    });
    client.session.set(TOKENS_1);

    await client.logout();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/auth/logout`);
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ refreshToken: "refresh-token-1" });
    expect(client.isAuthenticated).toBe(false);
  });
});

describe("ApiClient transport failures", () => {
  it("maps a rejected fetch to NetworkError without leaking URL or token", async () => {
    const { client } = makeClient(() => Promise.reject(new Error("getaddrinfo ENOTFOUND api.example.test")));
    client.session.set(TOKENS_1);

    const error = await client.listDeals().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).kind).toBe("network");
    expect((error as NetworkError).retryable).toBe(true);
    expect((error as Error).message).toBe("NETWORK_ERROR");
    expect((error as Error).message).not.toContain("api.example.test");
    expect((error as Error).message).not.toContain("access-token-1");
  });

  it("aborts a hanging request after the timeout and reports TimeoutError", async () => {
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const abortError = new Error("aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      });
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: hangingFetch,
      scheduler: realScheduler,
      timeoutMs: 10,
      maxRetries: 0,
    });
    client.session.set(TOKENS_1);

    const error = await client.listDeals().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).kind).toBe("timeout");
    expect((error as Error).message).toBe("REQUEST_TIMEOUT");
  });

  it("reports an already aborted signal as AbortedError without calling fetch", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ deals: [] }));
    client.session.set(TOKENS_1);
    const controller = new AbortController();
    controller.abort();

    await expect(client.listDeals({ signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
    expect(calls).toHaveLength(0);
  });

  it("rejects a 200 response with malformed JSON as InvalidJsonError", async () => {
    const { client } = makeClient(() => jsonResponse(undefined, { rawBody: "<html>oops</html>" }));
    client.session.set(TOKENS_1);

    await expect(client.listDeals()).rejects.toBeInstanceOf(InvalidJsonError);
  });

  it("treats a 204 empty body as success", async () => {
    const { client } = makeClient(() => jsonResponse(undefined, { status: 204 }));
    client.session.set(TOKENS_1);

    await expect(client.request<void>("/v1/anything", { method: "DELETE" })).resolves.toBeUndefined();
  });
});

describe("ApiClient error mapping", () => {
  it("maps 4xx to ClientError and keeps only allow-listed codes", async () => {
    const { client } = makeClient(() =>
      jsonResponse({ error: "AGENT_TASK_NOT_FOUND" }, { status: 404 }),
    );
    client.session.set(TOKENS_1);

    const error = await client.getTreasureAnalysis("task-1").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ClientError);
    expect((error as ClientError).status).toBe(404);
    expect((error as ClientError).code).toBe("AGENT_TASK_NOT_FOUND");
    expect((error as ClientError).retryable).toBe(false);
  });

  it("does not echo an arbitrary server string into the error", async () => {
    const { client } = makeClient(() =>
      jsonResponse({ error: "token=secret-value leaked from db" }, { status: 400 }),
    );
    client.session.set(TOKENS_1);

    const error = (await client.listDeals().catch((cause: unknown) => cause)) as ClientError;

    expect(error.code).toBeUndefined();
    expect(error.message).not.toContain("secret-value");
    expect(error.label).not.toContain("secret-value");
  });

  it("maps 429 to RateLimitedError with retryAfterMs from the header", async () => {
    const { client } = makeClient(() =>
      jsonResponse({ error: "RATE_LIMIT_EXCEEDED" }, { status: 429, headers: { "retry-after": "3" } }),
    );
    client.session.set(TOKENS_1);

    const error = (await client.listDeals().catch((cause: unknown) => cause)) as RateLimitedError;

    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(3000);
    expect(error.code).toBe("RATE_LIMIT_EXCEEDED");
    // The request layer must not sleep on its own; polling owns the wait.
    expect(error.retryable).toBe(false);
  });

  it("caps an absurd Retry-After at maxRetryAfterMs", async () => {
    const fake = createFakeFetch(() =>
      jsonResponse({ error: "RATE_LIMIT_EXCEEDED" }, { status: 429, headers: { "retry-after": "86400" } }),
    );
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: fake.fetch,
      scheduler: createFakeScheduler(),
      maxRetryAfterMs: 60_000,
    });
    client.session.set(TOKENS_1);

    const error = (await client.listDeals().catch((cause: unknown) => cause)) as RateLimitedError;
    expect(error.retryAfterMs).toBe(60_000);
  });

  it("parses Retry-After as seconds and as an HTTP date", () => {
    const now = Date.parse("2026-11-23T03:00:00.000Z");
    expect(parseRetryAfterMs("7", now)).toBe(7000);
    expect(parseRetryAfterMs("Mon, 23 Nov 2026 03:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfterMs("Mon, 23 Nov 2026 02:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("not-a-date", now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });
});

describe("ApiClient 5xx retry", () => {
  it("retries a GET with growing backoff and gives up at the cap", async () => {
    const { client, calls, scheduler } = makeClient(
      () => jsonResponse({ error: "INTERNAL_ERROR" }, { status: 500 }),
      { maxRetries: 2 },
    );
    client.session.set(TOKENS_1);

    const error = (await client.listDeals().catch((cause: unknown) => cause)) as ServerError;

    expect(error).toBeInstanceOf(ServerError);
    expect(error.retryable).toBe(true);
    expect(calls).toHaveLength(3);
    // random() = 0.5 -> jitter factor exactly 1.0, so the delays are the raw ones.
    expect(scheduler.sleeps).toEqual([1000, 2000]);
  });

  it("recovers when a retry succeeds", async () => {
    const { client, calls } = makeClient(
      (_call, index) =>
        index === 1
          ? jsonResponse({ error: "INTERNAL_ERROR" }, { status: 503 })
          : jsonResponse({ deals: [{ id: "deal-1" }] }),
      { maxRetries: 2 },
    );
    client.session.set(TOKENS_1);

    const deals = await client.listDeals();

    expect(deals).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("never retries a write by default", async () => {
    const { client, calls } = makeClient(
      () => jsonResponse({ error: "INTERNAL_ERROR" }, { status: 500 }),
      { maxRetries: 3 },
    );
    client.session.set(TOKENS_1);

    await expect(
      client.startTreasureAnalysis("deal-1", "https://images.example.test/item.jpg", {
        idempotencyKey: "mobile-test-key-1",
      }),
    ).rejects.toBeInstanceOf(ServerError);

    expect(calls).toHaveLength(1);
  });

  it("sends the idempotency key required by the treasure-analysis endpoint", async () => {
    const { client, calls } = makeClient(() =>
      jsonResponse({ taskId: "task-1", status: "QUEUED", execution: "PENDING_WORKER" }, { status: 202 }),
    );
    client.session.set(TOKENS_1);

    const task = await client.startTreasureAnalysis("deal-1", "https://images.example.test/item.jpg", {
      idempotencyKey: "mobile-test-key-1",
    });

    expect(task.taskId).toBe("task-1");
    expect(calls[0]!.url).toBe(`${BASE}/v1/deals/deal-1/treasure-analysis`);
    expect(calls[0]!.init.headers?.["x-idempotency-key"]).toBe("mobile-test-key-1");
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ imageUrl: "https://images.example.test/item.jpg" });
  });
});

describe("ApiClient session expiry", () => {
  it("refreshes once on 401 and replays the request with the new token", async () => {
    const { client, calls } = makeClient((call) => {
      if (call.url.endsWith("/v1/auth/refresh")) return jsonResponse(TOKENS_2);
      if (authHeader(call) === "Bearer access-token-2") return jsonResponse({ deals: [] });
      return jsonResponse({ error: "AUTH_TOKEN_EXPIRED_OR_NOT_ACTIVE" }, { status: 401 });
    });
    client.session.set(TOKENS_1);

    await expect(client.listDeals()).resolves.toEqual([]);

    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/v1/deals`,
      `${BASE}/v1/auth/refresh`,
      `${BASE}/v1/deals`,
    ]);
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({ refreshToken: "refresh-token-1" });
    expect(client.session.accessToken).toBe("access-token-2");
    expect(client.session.refreshToken).toBe("refresh-token-2");
  });

  it("ends in SessionExpiredError after exactly one failed refresh, without a loop", async () => {
    const { client, calls } = makeClient((call) => {
      if (call.url.endsWith("/v1/auth/refresh")) {
        return jsonResponse({ error: "INVALID_REFRESH_TOKEN" }, { status: 401 });
      }
      return jsonResponse({ error: "AUTH_TOKEN_EXPIRED_OR_NOT_ACTIVE" }, { status: 401 });
    });
    client.session.set(TOKENS_1);

    await expect(client.listDeals()).rejects.toBeInstanceOf(SessionExpiredError);

    expect(calls).toHaveLength(2);
    expect(client.isAuthenticated).toBe(false);
  });

  it("does not refresh a second time when the refreshed token is rejected too", async () => {
    const { client, calls } = makeClient((call) =>
      call.url.endsWith("/v1/auth/refresh")
        ? jsonResponse(TOKENS_2)
        : jsonResponse({ error: "AUTH_TOKEN_INVALID" }, { status: 401 }),
    );
    client.session.set(TOKENS_1);

    await expect(client.listDeals()).rejects.toBeInstanceOf(SessionExpiredError);

    expect(calls.filter((call) => call.url.endsWith("/v1/auth/refresh"))).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(client.isAuthenticated).toBe(false);
  });

  it("shares a single refresh between concurrent 401s (single flight)", async () => {
    let refreshCalls = 0;
    const { client } = makeClient(async (call) => {
      if (call.url.endsWith("/v1/auth/refresh")) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonResponse(TOKENS_2);
      }
      if (authHeader(call) === "Bearer access-token-2") return jsonResponse({ deals: [] });
      return jsonResponse({ error: "AUTH_TOKEN_EXPIRED_OR_NOT_ACTIVE" }, { status: 401 });
    });
    client.session.set(TOKENS_1);

    const [first, second] = await Promise.all([client.listDeals(), client.listDeals()]);

    expect(refreshCalls).toBe(1);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });

  it("keeps the session when the refresh fails for transport reasons", async () => {
    const { client } = makeClient((call) => {
      if (call.url.endsWith("/v1/auth/refresh")) throw new Error("offline");
      return jsonResponse({ error: "AUTH_TOKEN_EXPIRED_OR_NOT_ACTIVE" }, { status: 401 });
    });
    client.session.set(TOKENS_1);

    const error = await client.listDeals().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(NetworkError);
    expect(client.isAuthenticated).toBe(true);
    expect(client.session.refreshToken).toBe("refresh-token-1");
  });

  it("does not refresh a request that was sent without auth", async () => {
    const { client, calls } = makeClient(() =>
      jsonResponse({ error: "INVALID_CREDENTIALS" }, { status: 401 }),
    );

    const error = (await client
      .login("operator@example.test", "falsches-passwort")
      .catch((cause: unknown) => cause)) as UnauthorizedError;

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error.code).toBe("INVALID_CREDENTIALS");
    // Exactly one call: no refresh attempt for the login request itself.
    expect(calls).toHaveLength(1);
    expect(client.isAuthenticated).toBe(false);
  });
});

describe("backoff", () => {
  it("grows exponentially and stops at the cap", () => {
    const base = { initialDelayMs: 1000, maxDelayMs: 8000, factor: 2 };
    expect([1, 2, 3, 4, 5].map((attempt) => computeBackoffBase(attempt, base))).toEqual([
      1000, 2000, 4000, 8000, 8000,
    ]);
  });

  it("keeps jitter inside the documented bounds and never above the cap", () => {
    const options = {
      initialDelayMs: 1000,
      maxDelayMs: 8000,
      factor: 2,
      jitterRatio: 0.2,
    };
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const base = computeBackoffBase(attempt, options);
      const low = computeBackoffDelay(attempt, { ...options, random: () => 0 });
      const mid = computeBackoffDelay(attempt, { ...options, random: () => 0.5 });
      const high = computeBackoffDelay(attempt, { ...options, random: () => 1 });

      expect(low).toBe(Math.round(base * 0.8));
      expect(mid).toBe(base);
      expect(high).toBe(Math.min(options.maxDelayMs, Math.round(base * 1.2)));
      expect(low).toBeLessThanOrEqual(mid);
      expect(mid).toBeLessThanOrEqual(high);
      expect(high).toBeLessThanOrEqual(options.maxDelayMs);
    }
  });

  it("is deterministic for a fixed random source", () => {
    const options = { initialDelayMs: 500, maxDelayMs: 30_000, factor: 2, jitterRatio: 0.2, random: () => 0.25 };
    expect(computeBackoffDelay(3, options)).toBe(computeBackoffDelay(3, options));
    expect(computeBackoffDelay(0, options)).toBe(computeBackoffDelay(1, options));
  });
});
