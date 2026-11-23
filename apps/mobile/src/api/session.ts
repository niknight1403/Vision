/**
 * Session state with single-flight refresh.
 *
 * A 401 on a request triggers at most one refresh attempt; concurrent 401s
 * share the same in-flight refresh promise instead of rotating the refresh
 * token twice (the API revokes a rotated refresh token, so a double refresh
 * would log the user out).
 */

import { SessionExpiredError } from "./errors";
import type { AuthTokenPair } from "./types";

export type RefreshFunction = (refreshToken: string) => Promise<AuthTokenPair>;

export class SessionStore {
  private tokens: AuthTokenPair | null = null;
  private pending: Promise<AuthTokenPair> | null = null;
  private readonly refreshFn: RefreshFunction;

  constructor(refreshFn: RefreshFunction) {
    this.refreshFn = refreshFn;
  }

  get accessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }

  get refreshToken(): string | null {
    return this.tokens?.refreshToken ?? null;
  }

  get isAuthenticated(): boolean {
    return this.tokens !== null;
  }

  get snapshot(): AuthTokenPair | null {
    return this.tokens;
  }

  set(tokens: AuthTokenPair): void {
    if (!tokens || typeof tokens.accessToken !== "string" || !tokens.accessToken) {
      throw new SessionExpiredError({ code: "TOKEN_RESPONSE_INVALID" });
    }
    this.tokens = tokens;
  }

  clear(): void {
    this.tokens = null;
    this.pending = null;
  }

  /** At most one refresh in flight. Rejects with SessionExpiredError without a token. */
  refresh(): Promise<AuthTokenPair> {
    if (this.pending) return this.pending;
    const current = this.tokens?.refreshToken;
    if (!current) return Promise.reject(new SessionExpiredError());
    const pending = (async () => {
      try {
        const next = await this.refreshFn(current);
        this.tokens = next;
        return next;
      } finally {
        this.pending = null;
      }
    })();
    this.pending = pending;
    return pending;
  }
}
