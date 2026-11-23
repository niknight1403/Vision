/**
 * Typed transport errors for the mobile API layer.
 *
 * The message of every error is a fixed machine-readable token plus, at most,
 * an allow-listed server error code. URLs, bearer tokens, request bodies and
 * response bodies are never copied into a message: screens render these
 * strings directly and they end up in logs and crash reports.
 */

export type ApiErrorKind =
  | "network"
  | "timeout"
  | "aborted"
  | "unauthorized"
  | "session_expired"
  | "rate_limited"
  | "server"
  | "client"
  | "invalid_json"
  | "invalid_response"
  | "task_failed";

/** Server error codes are upper-case snake case tokens, nothing else is echoed. */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined;
}

export interface ApiErrorOptions {
  status?: number;
  code?: string;
  retryAfterMs?: number;
  retryable?: boolean;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(kind: ApiErrorKind, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
    // Keeps `instanceof` working when the class is transpiled to ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Stable, UI-safe label. Never contains a URL, token or payload. */
  get label(): string {
    return this.code ? `${this.message}: ${this.code}` : this.message;
  }
}

export class NetworkError extends ApiError {
  constructor(options: ApiErrorOptions = {}) {
    super("network", "NETWORK_ERROR", { retryable: true, ...options });
    this.name = "NetworkError";
  }
}

export class TimeoutError extends ApiError {
  constructor(options: ApiErrorOptions = {}) {
    super("timeout", "REQUEST_TIMEOUT", { retryable: true, ...options });
    this.name = "TimeoutError";
  }
}

export class AbortedError extends ApiError {
  constructor(options: ApiErrorOptions = {}) {
    super("aborted", "REQUEST_ABORTED", { retryable: false, ...options });
    this.name = "AbortedError";
  }
}

/** The API answered 401. A single refresh attempt may still fix this. */
export class UnauthorizedError extends ApiError {
  constructor(options: ApiErrorOptions = {}) {
    super("unauthorized", "UNAUTHORIZED", { status: 401, retryable: false, ...options });
    this.name = "UnauthorizedError";
  }
}

/** Refresh was attempted once and did not yield a usable session. Logout state. */
export class SessionExpiredError extends ApiError {
  constructor(options: ApiErrorOptions = {}) {
    super("session_expired", "SESSION_EXPIRED", { retryable: false, ...options });
    this.name = "SessionExpiredError";
  }
}

export class RateLimitedError extends ApiError {
  constructor(options: ApiErrorOptions = {}) {
    super("rate_limited", "RATE_LIMITED", { status: 429, retryable: false, ...options });
    this.name = "RateLimitedError";
  }
}

export class ServerError extends ApiError {
  constructor(options: ApiErrorOptions = {}) {
    super("server", "SERVER_ERROR", { retryable: true, ...options });
    this.name = "ServerError";
  }
}

export class ClientError extends ApiError {
  constructor(options: ApiErrorOptions = {}) {
    super("client", "CLIENT_ERROR", { retryable: false, ...options });
    this.name = "ClientError";
  }
}

export class InvalidJsonError extends ApiError {
  constructor(options: ApiErrorOptions = {}) {
    super("invalid_json", "INVALID_JSON_RESPONSE", { retryable: false, ...options });
    this.name = "InvalidJsonError";
  }
}

export class InvalidResponseError extends ApiError {
  constructor(options: ApiErrorOptions = {}) {
    super("invalid_response", "INVALID_RESPONSE_SHAPE", { retryable: false, ...options });
    this.name = "InvalidResponseError";
  }
}

/** The polled task itself ended in FAILED/CANCELLED. Not a transport failure. */
export class TaskFailedError extends ApiError {
  constructor(status: string, options: ApiErrorOptions = {}) {
    super("task_failed", status === "CANCELLED" ? "TASK_CANCELLED" : "TASK_FAILED", {
      code: status === "CANCELLED" ? "TASK_CANCELLED" : "TASK_FAILED",
      retryable: false,
      ...options,
    });
    this.name = "TaskFailedError";
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
