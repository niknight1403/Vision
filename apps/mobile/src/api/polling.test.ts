import { describe, expect, it } from "vitest";

import { ApiClient, type FetchLike } from "./client";
import {
  AbortedError,
  ClientError,
  NetworkError,
  RateLimitedError,
  ServerError,
  TaskFailedError,
} from "./errors";
import {
  pollTaskStatus,
  type PollSnapshot,
  type PollTaskSource,
} from "./polling";
import { realScheduler, type Scheduler } from "./scheduler";
import type { AuthTokenPair, TreasureAnalysisTask } from "./types";
import { createFakeFetch, createFakeScheduler, jsonResponse } from "./test-support";

const BASE = "https://api.example.test";
const TOKENS: AuthTokenPair = {
  tokenType: "Bearer",
  accessToken: "access-token-1",
  accessTokenExpiresIn: 900,
  refreshToken: "refresh-token-1",
  refreshTokenExpiresAt: "2026-12-23T00:00:00.000Z",
};

type Step = { status: string } | Error;

function taskSource(steps: Step[]): { source: PollTaskSource; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const source: PollTaskSource = {
    async getTreasureAnalysis(taskId: string): Promise<TreasureAnalysisTask> {
      calls.push(taskId);
      const step = steps[Math.min(index, steps.length - 1)]!;
      index += 1;
      if (step instanceof Error) throw step;
      return { taskId, status: step.status };
    },
  };
  return { source, calls };
}

function collect(): { snapshots: PollSnapshot[]; onSnapshot: (snapshot: PollSnapshot) => void } {
  const snapshots: PollSnapshot[] = [];
  return { snapshots, onSnapshot: (snapshot) => snapshots.push(snapshot) };
}

describe("pollTaskStatus success path", () => {
  it("polls until SUCCEEDED and resolves with the task", async () => {
    const { source, calls } = taskSource([
      { status: "QUEUED" },
      { status: "RUNNING" },
      { status: "SUCCEEDED" },
    ]);
    const scheduler = createFakeScheduler();
    const { snapshots, onSnapshot } = collect();

    const handle = pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler,
      random: () => 0.5,
      onSnapshot,
    });
    const final = await handle.promise;

    expect(final.state).toBe("success");
    expect(final.task?.status).toBe("SUCCEEDED");
    expect(final.polls).toBe(3);
    expect(calls).toEqual(["task-1", "task-1", "task-1"]);
    expect(snapshots.at(-1)?.state).toBe("success");
    expect(snapshots.slice(0, -1).every((snapshot) => snapshot.state === "loading")).toBe(true);
    // A healthy task keeps the base interval instead of growing the backoff.
    expect(scheduler.sleeps).toEqual([1000, 1000]);
  });

  it("reports a FAILED task as an explicit error state, not an exception", async () => {
    const { source, calls } = taskSource([{ status: "RUNNING" }, { status: "FAILED" }]);
    const { snapshots, onSnapshot } = collect();

    const final = await pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler: createFakeScheduler(),
      onSnapshot,
    }).promise;

    expect(final.state).toBe("error");
    expect(final.task?.status).toBe("FAILED");
    expect(final.error).toBeInstanceOf(TaskFailedError);
    expect(final.error?.code).toBe("TASK_FAILED");
    expect(calls).toHaveLength(2);
    expect(snapshots.at(-1)?.state).toBe("error");
  });

  it("reports CANCELLED with its own code", async () => {
    const { source } = taskSource([{ status: "CANCELLED" }]);

    const final = await pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler: createFakeScheduler(),
    }).promise;

    expect(final.state).toBe("error");
    expect(final.error?.code).toBe("TASK_CANCELLED");
  });
});

describe("pollTaskStatus offline and retry states", () => {
  it("goes through 'offline' on a network error and recovers", async () => {
    const { source, calls } = taskSource([
      new NetworkError(),
      { status: "RUNNING" },
      { status: "SUCCEEDED" },
    ]);
    const scheduler = createFakeScheduler();
    const { snapshots, onSnapshot } = collect();

    const final = await pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler,
      random: () => 0.5,
      onSnapshot,
    }).promise;

    expect(snapshots.map((snapshot) => snapshot.state)).toContain("offline");
    expect(final.state).toBe("success");
    expect(calls).toHaveLength(3);
    // Failure grew the delay, the successful poll reset it to the base interval.
    expect(scheduler.sleeps).toEqual([1000, 1000]);
  });

  it("grows the backoff across consecutive failures and stops at the cap", async () => {
    const { source, calls } = taskSource([new NetworkError()]);
    const scheduler = createFakeScheduler();

    const final = await pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler,
      random: () => 0.5,
      initialDelayMs: 1000,
      maxDelayMs: 8000,
      maxAttempts: 6,
      onSnapshot: () => undefined,
    }).promise;

    expect(final.state).toBe("offline");
    expect(final.attempt).toBe(6);
    expect(calls).toHaveLength(6);
    expect(scheduler.sleeps).toEqual([1000, 2000, 4000, 8000, 8000]);
  });

  it("gives up on repeated 5xx at the attempt cap with state 'error'", async () => {
    const { source, calls } = taskSource([new ServerError({ status: 503 })]);
    const scheduler = createFakeScheduler();

    const final = await pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler,
      random: () => 0.5,
      maxAttempts: 3,
    }).promise;

    expect(final.state).toBe("error");
    expect(final.error).toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(3);
    expect(scheduler.sleeps).toEqual([1000, 2000]);
  });

  it("does not retry a deterministic 4xx", async () => {
    const { source, calls } = taskSource([new ClientError({ status: 404, code: "AGENT_TASK_NOT_FOUND" })]);

    const final = await pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler: createFakeScheduler(),
    }).promise;

    expect(final.state).toBe("error");
    expect(final.error?.code).toBe("AGENT_TASK_NOT_FOUND");
    expect(calls).toHaveLength(1);
  });

  it("keeps jittered delays inside the documented bounds", async () => {
    const { source } = taskSource([new NetworkError()]);
    const low = createFakeScheduler();
    const high = createFakeScheduler();

    await pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler: low,
      random: () => 0,
      maxAttempts: 3,
    }).promise;
    await pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler: high,
      random: () => 1,
      maxAttempts: 3,
    }).promise;

    expect(low.sleeps).toEqual([800, 1600]);
    expect(high.sleeps).toEqual([1200, 2400]);
  });
});

describe("pollTaskStatus rate limiting", () => {
  it("honours Retry-After on 429 and keeps polling afterwards", async () => {
    const { source, calls } = taskSource([
      new RateLimitedError({ status: 429, retryAfterMs: 7000, code: "RATE_LIMIT_EXCEEDED" }),
      { status: "RUNNING" },
      { status: "SUCCEEDED" },
    ]);
    const scheduler = createFakeScheduler();
    const { snapshots, onSnapshot } = collect();

    const final = await pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler,
      random: () => 0.5,
      onSnapshot,
    }).promise;

    expect(final.state).toBe("success");
    expect(scheduler.sleeps[0]).toBe(7000);
    expect(calls).toHaveLength(3);
    // A 429 is not a task failure and must not consume the failure budget.
    expect(final.attempt).toBe(0);
    expect(snapshots.some((snapshot) => snapshot.error instanceof RateLimitedError)).toBe(true);
  });

  it("stops after maxRateLimitWaits consecutive 429s", async () => {
    const { source, calls } = taskSource([new RateLimitedError({ status: 429, retryAfterMs: 1000 })]);

    const final = await pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler: createFakeScheduler(),
      maxRateLimitWaits: 2,
      maxAttempts: 10,
    }).promise;

    expect(final.state).toBe("error");
    expect(calls).toHaveLength(3);
  });
});

describe("pollTaskStatus cancellation", () => {
  function hangingScheduler(): { scheduler: Scheduler; entered: Promise<void> } {
    const base = createFakeScheduler();
    let notify: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const scheduler: Scheduler = {
      now: base.now,
      setTimeout: base.setTimeout,
      clearTimeout: base.clearTimeout,
      sleep: (_ms, signal) =>
        new Promise<void>((_resolve, reject) => {
          notify();
          signal?.addEventListener("abort", () => reject(new AbortedError()), { once: true });
        }),
    };
    return { scheduler, entered };
  }

  it("stop() ends the wait and resolves 'idle' without further requests", async () => {
    const { source, calls } = taskSource([{ status: "RUNNING" }]);
    const { scheduler, entered } = hangingScheduler();
    const handle = pollTaskStatus({ client: source, taskId: "task-1", scheduler });

    await entered;
    handle.stop();
    const final = await handle.promise;

    expect(final.state).toBe("idle");
    expect(final.stopped).toBe(true);
    expect(final.task?.status).toBe("RUNNING");
    expect(calls).toHaveLength(1);
  });

  it("an external AbortSignal stops the poller the same way", async () => {
    const { source, calls } = taskSource([{ status: "QUEUED" }]);
    const { scheduler, entered } = hangingScheduler();
    const controller = new AbortController();
    const handle = pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler,
      signal: controller.signal,
    });

    await entered;
    controller.abort();
    const final = await handle.promise;

    expect(final.state).toBe("idle");
    expect(final.stopped).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("an already aborted signal makes no request at all", async () => {
    const { source, calls } = taskSource([{ status: "QUEUED" }]);
    const controller = new AbortController();
    controller.abort();

    const final = await pollTaskStatus({
      client: source,
      taskId: "task-1",
      scheduler: createFakeScheduler(),
      signal: controller.signal,
    }).promise;

    expect(final.state).toBe("idle");
    expect(calls).toHaveLength(0);
  });
});

describe("pollTaskStatus against the real ApiClient", () => {
  it("ends in 'expired' when the refresh fails and never loops", async () => {
    const fake = createFakeFetch((call) =>
      call.url.endsWith("/v1/auth/refresh")
        ? jsonResponse({ error: "INVALID_REFRESH_TOKEN" }, { status: 401 })
        : jsonResponse({ error: "AUTH_TOKEN_EXPIRED_OR_NOT_ACTIVE" }, { status: 401 }),
    );
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: fake.fetch,
      scheduler: createFakeScheduler(),
      maxRetries: 0,
    });
    client.session.set(TOKENS);

    const final = await pollTaskStatus({
      client,
      taskId: "task-1",
      scheduler: createFakeScheduler(),
      random: () => 0.5,
    }).promise;

    expect(final.state).toBe("expired");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.filter((call) => call.url.includes("/v1/treasure-analyses/"))).toHaveLength(1);
    expect(client.isAuthenticated).toBe(false);
  });

  it("recovers through a refresh and still reaches SUCCEEDED", async () => {
    const fake = createFakeFetch((call) => {
      if (call.url.endsWith("/v1/auth/refresh")) return jsonResponse({ ...TOKENS, accessToken: "access-token-2" });
      if (call.init.headers?.authorization === "Bearer access-token-2") {
        return jsonResponse({ taskId: "task-1", status: "SUCCEEDED" });
      }
      return jsonResponse({ error: "AUTH_TOKEN_EXPIRED_OR_NOT_ACTIVE" }, { status: 401 });
    });
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: fake.fetch,
      scheduler: createFakeScheduler(),
      maxRetries: 0,
    });
    client.session.set(TOKENS);

    const final = await pollTaskStatus({
      client,
      taskId: "task-1",
      scheduler: createFakeScheduler(),
      random: () => 0.5,
    }).promise;

    expect(final.state).toBe("success");
    expect(fake.calls.map((call) => call.url)).toEqual([
      `${BASE}/v1/treasure-analyses/task-1`,
      `${BASE}/v1/auth/refresh`,
      `${BASE}/v1/treasure-analyses/task-1`,
    ]);
  });

  it("treats a request timeout as offline and recovers", async () => {
    let call = 0;
    const flakyFetch: FetchLike = (_url, init) => {
      call += 1;
      if (call > 1) {
        return Promise.resolve(jsonResponse({ taskId: "task-1", status: "SUCCEEDED" }));
      }
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const abortError = new Error("aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      });
    };
    const fakeSleep = createFakeScheduler();
    const hybridScheduler: Scheduler = {
      now: () => Date.now(),
      setTimeout: realScheduler.setTimeout,
      clearTimeout: realScheduler.clearTimeout,
      sleep: fakeSleep.sleep,
    };
    const client = new ApiClient({
      baseUrl: BASE,
      fetch: flakyFetch,
      scheduler: hybridScheduler,
      timeoutMs: 10,
      maxRetries: 0,
    });
    client.session.set(TOKENS);
    const { snapshots, onSnapshot } = collect();

    const final = await pollTaskStatus({
      client,
      taskId: "task-1",
      scheduler: hybridScheduler,
      random: () => 0.5,
      onSnapshot,
    }).promise;

    expect(snapshots.some((snapshot) => snapshot.state === "offline")).toBe(true);
    expect(final.state).toBe("success");
  });
});
