/**
 * HTTP adapter for the private Python vision worker.
 *
 * The worker owns the image-host allowlist, the downloader and the model call;
 * the API forwards an image URL plus the stored deal title and adds the shared
 * bearer secret. A visual score is never treated as an authenticity proof, and
 * a failed inspection never turns into a positive claim.
 */
export interface VisionInspectorOptions {
  /** Base URL of the private worker, for example http://127.0.0.1:8091. */
  url: string;
  /** Shared secret with the worker; the worker rejects anything shorter than 32 characters. */
  token: string;
  /** Hard cap for one inspection round trip. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface VisionInspector {
  inspectItemVisuals(imageUrl: string, hintTitle: string): Promise<Record<string, unknown>>;
}

const MIN_TOKEN_LENGTH = 32;
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_HINT_TITLE = 300;

export function createHttpVisionInspector(options: VisionInspectorOptions): VisionInspector {
  const token = options.token.trim();
  if (token.length < MIN_TOKEN_LENGTH) throw new Error("VISION_WORKER_TOKEN_TOO_SHORT");

  let base: URL;
  try {
    base = new URL(options.url);
  } catch {
    throw new Error("VISION_WORKER_URL_INVALID");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("VISION_WORKER_URL_INVALID");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("VISION_WORKER_TIMEOUT_INVALID");
  }

  const endpoint = new URL("/v1/visual-inspection", base).toString();
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async inspectItemVisuals(imageUrl: string, hintTitle: string): Promise<Record<string, unknown>> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await doFetch(endpoint, {
            method: "POST",
            headers: {
              authorization: "Bearer " + token,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              image_url: imageUrl,
              hint_title: hintTitle.slice(0, MAX_HINT_TITLE),
            }),
            signal: controller.signal,
          });
        } catch {
          if (controller.signal.aborted) throw new Error("VISION_WORKER_TIMEOUT");
          throw new Error("VISION_WORKER_UNAVAILABLE");
        }

        if (!response.ok) throw new Error("VISION_WORKER_REJECTED");

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new Error("VISION_WORKER_RESPONSE_INVALID");
        }

        const inspection = (payload as { visual_inspection?: unknown } | null)?.visual_inspection;
        if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
          throw new Error("VISION_WORKER_RESPONSE_INVALID");
        }
        return inspection as Record<string, unknown>;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
