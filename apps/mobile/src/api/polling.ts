/**
 * Polling for an agent task (/v1/treasure-analyses/:taskId).
 *
 * The poller never throws for expected conditions: it resolves with an
 * explicit `PollSnapshot.state` so a screen can render the situation instead
 * of only catching exceptions.
 *
 *  - exponential backoff with bounded jitter, capped at `maxDelayMs`
 *  - backoff grows only for *consecutive failures*; a healthy but still running
 *    task keeps the initial interval (no runaway wait for a long analysis)
 *  - 429 honours Retry-After and does not consume the failure budget
 *  - 401 that survives the client's single refresh attempt -> `expired`, stop
 *  - stop()/AbortSignal -> resolves `idle` with `stopped: true`, no further calls
 */

import { computeBackoffDelay, DEFAULT_BACKOFF } from "./backoff";
import {
  AbortedError,
  ApiError,
  ClientError,
  InvalidJsonError,
  NetworkError,
  RateLimitedError,
  ServerError,
  SessionExpiredError,
  TaskFailedError,
  UnauthorizedError,
} from "./errors";
import { realScheduler, type Scheduler } from "./scheduler";
import type { TreasureAnalysisTask } from "./types";

export type PollingState = "idle" | "loading" | "offline" | "error" | "expired" | "success";

export interface PollSnapshot {
  state: PollingState;
  taskId: string;
  /** Consecutive failed attempts; 0 while the task answers normally. */
  attempt: number;
  /** Number of completed request rounds. */
  polls: number;
  task?: TreasureAnalysisTask;
  error?: ApiError;
  /** Delay the poller is about to wait, so the UI can show a countdown. */
  nextDelayMs?: number;
  stopped?: boolean;
}

export interface PollTaskSource {
  getTreasureAnalysis(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<TreasureAnalysisTask>;
}

export interface PollTaskOptions {
  client: PollTaskSource;
  taskId: string;
  signal?: AbortSignal;
  scheduler?: Scheduler;
  random?: () => number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitterRatio?: number;
  /** Consecutive failures before the poller gives up. Default 8. */
  maxAttempts?: number;
  /** Consecutive 429 answers tolerated. Default 5. */
  maxRateLimitWaits?: number;
  onSnapshot?: (snapshot: PollSnapshot) => void;
}

export interface PollHandle {
  readonly promise: Promise<PollSnapshot>;
  readonly signal: AbortSignal;
  stop(): void;
}

export function pollTaskStatus(options: PollTaskOptions): PollHandle {
  const scheduler = options.scheduler ?? realScheduler;
  const random = options.random ?? Math.random;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 8);
  const maxRateLimitWaits = Math.max(0, options.maxRateLimitWaits ?? 5);
  const backoff = {
    initialDelayMs: options.initialDelayMs ?? DEFAULT_BACKOFF.initialDelayMs,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_BACKOFF.maxDelayMs,
    factor: options.factor ?? DEFAULT_BACKOFF.factor,
    jitterRatio: options.jitterRatio ?? DEFAULT_BACKOFF.jitterRatio,
    random,
  };

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let attempt = 0;
  let polls = 0;
  let rateLimitWaits = 0;
  let lastTask: TreasureAnalysisTask | undefined;

  const cleanup = () => options.signal?.removeEventListener("abort", onExternalAbort);
  const emit = (snapshot: PollSnapshot): PollSnapshot => {
    options.onSnapshot?.(snapshot);
    return snapshot;
  };
  const finish = (snapshot: PollSnapshot): PollSnapshot => {
    cleanup();
    return emit(snapshot);
  };
  const stoppedSnapshot = (error?: ApiError): PollSnapshot =>
    finish({
      state: "idle",
      taskId: options.taskId,
      attempt,
      polls,
      task: lastTask,
      stopped: true,
      ...(error === undefined ? {} : { error }),
    });

  const run = async (): Promise<PollSnapshot> => {
    emit({ state: "loading", taskId: options.taskId, attempt: 0, polls: 0 });

    for (;;) {
      if (controller.signal.aborted) return stoppedSnapshot();

      polls += 1;
      let state: PollingState = "loading";
      let error: ApiError | undefined;
      let task: TreasureAnalysisTask | undefined;

      try {
        task = await options.client.getTreasureAnalysis(options.taskId, {
          signal: controller.signal,
        });
        lastTask = task;
        if (task.status === "SUCCEEDED") {
          return finish({ state: "success", taskId: options.taskId, attempt, polls, task });
        }
        if (task.status === "FAILED" || task.status === "CANCELLED") {
          return finish({
            state: "error",
            taskId: options.taskId,
            attempt,
            polls,
            task,
            error: new TaskFailedError(task.status),
          });
        }
        // Still QUEUED/RUNNING/CHECKPOINTED: healthy, keep the base interval.
        attempt = 0;
      } catch (cause) {
        error = cause instanceof ApiError ? cause : new NetworkError({ cause });
        attempt += 1;

        if (error instanceof AbortedError || controller.signal.aborted) {
          return stoppedSnapshot(error);
        }
        if (error instanceof SessionExpiredError || error instanceof UnauthorizedError) {
          return finish({
            state: "expired",
            taskId: options.taskId,
            attempt,
            polls,
            task: lastTask,
            error,
          });
        }
        if (error instanceof RateLimitedError) {
          rateLimitWaits += 1;
          // A 429 is not a failure of the task; it must not eat the budget.
          attempt -= 1;
          if (rateLimitWaits > maxRateLimitWaits) {
            return finish({
              state: "error",
              taskId: options.taskId,
              attempt,
              polls,
              task: lastTask,
              error,
            });
          }
          const delay = error.retryAfterMs ?? computeBackoffDelay(rateLimitWaits, backoff);
          emit({
            state: "loading",
            taskId: options.taskId,
            attempt,
            polls,
            task: lastTask,
            error,
            nextDelayMs: delay,
          });
          if (!(await sleepOrStop(scheduler, delay, controller.signal))) {
            return stoppedSnapshot(error);
          }
          continue;
        }
        if (error instanceof ClientError || error instanceof InvalidJsonError) {
          // Deterministic 4xx / malformed payload: retrying cannot help.
          return finish({
            state: "error",
            taskId: options.taskId,
            attempt,
            polls,
            task: lastTask,
            error,
          });
        }

        state = error instanceof ServerError ? "error" : "offline";
        if (attempt >= maxAttempts) {
          return finish({
            state,
            taskId: options.taskId,
            attempt,
            polls,
            task: lastTask,
            error,
          });
        }
      }

      const delay = computeBackoffDelay(attempt === 0 ? 1 : attempt, backoff);
      emit({
        state,
        taskId: options.taskId,
        attempt,
        polls,
        ...(task === undefined ? {} : { task }),
        ...(error === undefined ? {} : { error }),
        nextDelayMs: delay,
      });
      if (!(await sleepOrStop(scheduler, delay, controller.signal))) {
        return stoppedSnapshot(error);
      }
    }
  };

  const promise = run();

  return {
    promise,
    get signal() {
      return controller.signal;
    },
    stop: () => {
      controller.abort();
    },
  };
}

async function sleepOrStop(scheduler: Scheduler, ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  try {
    await scheduler.sleep(ms, signal);
    return !signal.aborted;
  } catch {
    return false;
  }
}
