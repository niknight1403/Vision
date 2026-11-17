import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderHttpClient,
  ProviderHttpError,
} from "./http-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ProviderHttpClient", () => {
  it("rejects non-HTTPS and non-allowlisted base URLs", () => {
    expect(() => new ProviderHttpClient({
      baseUrl: "http://api.vendor.example",
      allowedHosts: ["api.vendor.example"],
    })).toThrow(/allowlisted HTTPS/);

    expect(() => new ProviderHttpClient({
      baseUrl: "https://other.example",
      allowedHosts: ["api.vendor.example"],
    })).toThrow(/allowlisted HTTPS/);
  });

  it("rejects request paths that escape the configured base path", async () => {
    const client = new ProviderHttpClient({
      baseUrl: "https://api.vendor.example/v1/",
      allowedHosts: ["api.vendor.example"],
    });
    await expect(client.getJson("/admin/secrets")).rejects.toThrow(/escaped/);

    const prefixBypass = new ProviderHttpClient({
      baseUrl: "https://api.vendor.example/v1",
      allowedHosts: ["api.vendor.example"],
    });
    await expect(prefixBypass.getJson("/v1-evil/secret")).rejects.toThrow(/escaped/);
  });

  it("sends server-side bearer credentials and parses JSON", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-secret");
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProviderHttpClient({
      baseUrl: "https://api.vendor.example/v1/",
      allowedHosts: ["api.vendor.example"],
      bearerToken: "server-secret",
    });

    await expect(client.getJson<{ items: unknown[] }>("products", { q: "camera" }))
      .resolves.toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized and non-JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("123456", {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const smallLimit = new ProviderHttpClient({
      baseUrl: "https://api.vendor.example/",
      allowedHosts: ["api.vendor.example"],
      maxResponseBytes: 3,
    });
    await expect(smallLimit.getJson("items")).rejects.toThrow(/size limit/);

    const streamedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"payload":"too large"}'));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamedBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    await expect(smallLimit.getJson("items")).rejects.toThrow(/size limit/);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })));
    const client = new ProviderHttpClient({
      baseUrl: "https://api.vendor.example/",
      allowedHosts: ["api.vendor.example"],
    });
    await expect(client.getJson("items")).rejects.toThrow(/not JSON/);
  });

  it("rejects non-success status and malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const client = new ProviderHttpClient({
      baseUrl: "https://api.vendor.example/",
      allowedHosts: ["api.vendor.example"],
    });
    await expect(client.getJson("items")).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 503,
    } satisfies Partial<ProviderHttpError>);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    await expect(client.getJson("items")).rejects.toThrow(/malformed JSON/);
  });

  it("uses an abort timeout and clears its timer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ));
    const client = new ProviderHttpClient({
      baseUrl: "https://api.vendor.example/",
      allowedHosts: ["api.vendor.example"],
      timeoutMs: 25,
    });
    const pending = client.getJson("items");
    // Attach the rejection handler before advancing fake timers so Vitest
    // does not report the expected abort as an unhandled rejection.
    const rejection = expect(pending).rejects.toThrow(/aborted or timed out/);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
