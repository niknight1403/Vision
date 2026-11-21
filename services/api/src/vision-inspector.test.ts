import { describe, expect, it, vi } from "vitest";
import { createHttpVisionInspector } from "./vision-inspector.js";

const TOKEN = "worker-token-with-at-least-32-characters";
const BASE = "http://127.0.0.1:8091";
const IMAGE = "https://images.example.test/item.jpg";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createHttpVisionInspector", () => {
  it("rejects a token shorter than the worker minimum", () => {
    expect(() => createHttpVisionInspector({ url: BASE, token: "too-short" }))
      .toThrowError("VISION_WORKER_TOKEN_TOO_SHORT");
  });

  it("rejects a URL that is not http(s)", () => {
    expect(() => createHttpVisionInspector({ url: "ftp://worker", token: TOKEN }))
      .toThrowError("VISION_WORKER_URL_INVALID");
    expect(() => createHttpVisionInspector({ url: "not a url", token: TOKEN }))
      .toThrowError("VISION_WORKER_URL_INVALID");
  });

  it("rejects a timeout outside the allowed range", () => {
    expect(() => createHttpVisionInspector({ url: BASE, token: TOKEN, timeoutMs: 10 }))
      .toThrowError("VISION_WORKER_TIMEOUT_INVALID");
  });

  it("posts the visual-only request with the shared bearer token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ visual_inspection: { identified: false, details: "unbekannt" } }));
    const inspector = createHttpVisionInspector({ url: BASE, token: TOKEN, fetchImpl });

    const inspection = await inspector.inspectItemVisuals(IMAGE, "Anzeigentitel");

    expect(inspection).toEqual({ identified: false, details: "unbekannt" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8091/v1/visual-inspection");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer " + TOKEN);
    expect(JSON.parse(String(init.body))).toEqual({ image_url: IMAGE, hint_title: "Anzeigentitel" });
  });

  it("truncates the hint title to 300 characters", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ visual_inspection: { identified: false } }));
    const inspector = createHttpVisionInspector({ url: BASE, token: TOKEN, fetchImpl });

    await inspector.inspectItemVisuals(IMAGE, "t".repeat(400));

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).hint_title).toHaveLength(300);
  });

  it("reports a rejected worker call without leaking the response body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "WORKER_AUTH_REQUIRED" }, 401));
    const inspector = createHttpVisionInspector({ url: BASE, token: TOKEN, fetchImpl });

    await expect(inspector.inspectItemVisuals(IMAGE, "t")).rejects.toThrowError("VISION_WORKER_REJECTED");
  });

  it("reports an unreachable worker as unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const inspector = createHttpVisionInspector({ url: BASE, token: TOKEN, fetchImpl });

    await expect(inspector.inspectItemVisuals(IMAGE, "t")).rejects.toThrowError("VISION_WORKER_UNAVAILABLE");
  });

  it("aborts a call that exceeds the timeout", async () => {
    const fetchImpl = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const inspector = createHttpVisionInspector({ url: BASE, token: TOKEN, timeoutMs: 1000, fetchImpl });

    await expect(inspector.inspectItemVisuals(IMAGE, "t")).rejects.toThrowError("VISION_WORKER_TIMEOUT");
  });

  it("rejects a response without a visual_inspection object", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ assessment: {} }));
    const inspector = createHttpVisionInspector({ url: BASE, token: TOKEN, fetchImpl });

    await expect(inspector.inspectItemVisuals(IMAGE, "t")).rejects.toThrowError("VISION_WORKER_RESPONSE_INVALID");
  });
});
