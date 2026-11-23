/**
 * Small injectable clock/sleep/timer abstraction.
 *
 * Everything that waits in the client layer goes through this interface so
 * unit tests run without real timers, without React Native and without a
 * device. The default implementation only uses globals that exist both in
 * React Native and in Node.
 */

import { AbortedError } from "./errors";

export interface TimerHandle {
  readonly id: unknown;
}

export interface Scheduler {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new AbortedError());
    return new Promise<void>((resolve, reject) => {
      const handle = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      const onAbort = () => {
        clearTimeout(handle);
        reject(new AbortedError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
  setTimeout: (handler: () => void, ms: number): TimerHandle => ({
    id: setTimeout(handler, Math.max(0, ms)),
  }),
  clearTimeout: (handle: TimerHandle) => {
    clearTimeout(handle.id as ReturnType<typeof setTimeout>);
  },
};
