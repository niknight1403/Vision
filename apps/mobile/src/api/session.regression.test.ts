import { describe, it, expect, vi } from "vitest";
import { SessionStore } from "./session";
import type { AuthTokenPair } from "./types";

const pair = (id: string) => ({ accessToken: id, refreshToken: id }) as AuthTokenPair;
describe("session refresh regression", () => {
  it("does not restore a cleared session", async () => {
    let resolve!: (value: AuthTokenPair) => void;
    const store = new SessionStore(() => new Promise(r => { resolve = r; }));
    store.set(pair("old"));
    const pending = store.refresh();
    const assertion = expect(pending).rejects.toThrow();
    await Promise.resolve();
    store.clear();
    resolve(pair("late"));
    await assertion;
    expect(store.isAuthenticated).toBe(false);
  });
  it("shares concurrent refresh requests", async () => {
    const refresh = vi.fn(async () => pair("new"));
    const store = new SessionStore(refresh);
    store.set(pair("old"));
    await Promise.all([store.refresh(), store.refresh()]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.accessToken).toBe("new");
  });
  it("does not overwrite a new login", async () => {
    let resolve!: (value: AuthTokenPair) => void;
    const store = new SessionStore(() => new Promise(r => { resolve = r; }));
    store.set(pair("old"));
    const pending = store.refresh();
    const assertion = expect(pending).rejects.toThrow();
    await Promise.resolve();
    store.set(pair("new-login"));
    resolve(pair("late"));
    await assertion;
    expect(store.accessToken).toBe("new-login");
  });
});
