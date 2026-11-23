/**
 * Deterministic test doubles for the API layer. Not a test suite itself:
 * imported by the *.test.ts files so they never touch real timers, sockets or
 * React Native.
 */

import type { FetchInit, FetchLike, HttpResponseLike } from "./client";
import { AbortedError } from "./errors";
import type { Scheduler, TimerHandle } from "./scheduler";

export interface FakeScheduler extends Scheduler {
  readonly sleeps: number[];
  readonly pendingTimeouts: number;
}

export function createFakeScheduler(startAt = 1_700_000_000_000): FakeScheduler {
  let now = startAt;
  const sleeps: number[] = [];
  const timers = new Set<TimerHandle>();
  let nextId = 0;
  const scheduler: FakeScheduler = {
    now: () => now,
    async sleep(ms: number, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) throw new AbortedError();
      sleeps.push(ms);
      now += ms;
    },
    setTimeout(handler: () => void, _ms: number): TimerHandle {
      const handle = { id: nextId++ };
      timers.add(handle);
      // Timeouts never fire on their own in tests; the caller decides.
      void handler;
      return handle;
    },
    clearTimeout(handle: TimerHandle): void {
      timers.delete(handle);
    },
    get sleeps() {
      return sleeps;
    },
    get pendingTimeouts() {
      return timers.size;
    },
  };
  return scheduler;
}

export function headersOf(record: Record<string, string> = {}): { get(name: string): string | null } {
  const lower = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

export function jsonResponse(
  body: unknown,
  options: { status?: number; headers?: Record<string, string>; rawBody?: string } = {},
): HttpResponseLike {
  const status = options.status ?? 200;
  const text = options.rawBody ?? (body === undefined ? "" : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headersOf(options.headers),
    text: async () => text,
  };
}

export interface RecordedCall {
  url: string;
  init: FetchInit;
}

export interface FakeFetch {
  fetch: FetchLike;
  calls: RecordedCall[];
}

/**
 * @param handler receives the call and its 1-based index; returning a rejected
 *                promise simulates a transport failure.
 */
export function createFakeFetch(
  handler: (call: RecordedCall, index: number) => Promise<HttpResponseLike> | HttpResponseLike,
): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return await handler(call, calls.length);
  };
  return { fetch, calls };
}

export function authHeader(call: RecordedCall): string | undefined {
  return call.init.headers?.authorization;
}
