import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { authenticateBearerToken, requireAdmin } from "./auth-service.js";

const secret = "test-secret-that-is-at-least-thirty-two-bytes";
const now = 1_800_000_000;

function token(claimOverrides: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode(header);
  const body = encode({
    sub: "user-1",
    iss: "autonomagent-auth",
    aud: "autonomagent-api",
    iat: now - 10,
    exp: now + 600,
    ...claimOverrides,
  });
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

function prismaUser(user: unknown) {
  return {
    user: { findUnique: vi.fn().mockResolvedValue(user) },
  } as unknown as Pick<PrismaClient, "user">;
}

describe("bearer authentication", () => {
  it("loads the current role from the database, not token claims", async () => {
    const db = prismaUser({ id: "user-1", email: "admin@example.test", role: "ADMIN", disabledAt: null });
    const principal = await authenticateBearerToken(db, `Bearer ${token({ role: "VIEWER" })}`, secret, now);
    expect(principal).toEqual({ userId: "user-1", email: "admin@example.test", role: "ADMIN" });
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { id: true, email: true, role: true, disabledAt: true },
    });
    expect(() => requireAdmin(principal)).not.toThrow();
  });

  it("rejects missing, weak, malformed, and incorrectly signed credentials", async () => {
    const db = prismaUser(null);
    await expect(authenticateBearerToken(db, undefined, secret, now)).rejects.toThrow("AUTHENTICATION_REQUIRED");
    await expect(authenticateBearerToken(db, `Bearer ${token()}`, "short", now)).rejects.toThrow("AUTH_SIGNING_SECRET_NOT_CONFIGURED");
    await expect(authenticateBearerToken(db, "Bearer not-a-jwt", secret, now)).rejects.toThrow("AUTH_TOKEN_INVALID");
    const valid = token();
    await expect(authenticateBearerToken(db, `Bearer ${valid.slice(0, -1)}x`, secret, now)).rejects.toThrow("AUTH_TOKEN_INVALID");
  });

  it("rejects wrong algorithm, wrong audience, and overlong token lifetime", async () => {
    const db = prismaUser(null);
    await expect(authenticateBearerToken(db, `Bearer ${token({}, { alg: "none", typ: "JWT" })}`, secret, now)).rejects.toThrow("AUTH_TOKEN_INVALID");
    await expect(authenticateBearerToken(db, `Bearer ${token({ aud: "other" })}`, secret, now)).rejects.toThrow("AUTH_TOKEN_INVALID");
    await expect(authenticateBearerToken(db, `Bearer ${token({ exp: now + 3600 })}`, secret, now)).rejects.toThrow("AUTH_TOKEN_EXPIRED_OR_NOT_ACTIVE");
  });

  it("rejects expired tokens and unavailable or disabled users", async () => {
    await expect(authenticateBearerToken(prismaUser(null), `Bearer ${token({ exp: now })}`, secret, now)).rejects.toThrow("AUTH_TOKEN_EXPIRED_OR_NOT_ACTIVE");
    await expect(authenticateBearerToken(prismaUser(null), `Bearer ${token()}`, secret, now)).rejects.toThrow("AUTHENTICATED_USER_UNAVAILABLE");
    await expect(authenticateBearerToken(prismaUser({ id: "user-1", email: "x", role: "ADMIN", disabledAt: new Date() }), `Bearer ${token()}`, secret, now)).rejects.toThrow("AUTHENTICATED_USER_UNAVAILABLE");
  });

  it("enforces ADMIN role from the current database principal", () => {
    expect(() => requireAdmin({ userId: "u", email: "u@example.test", role: "VIEWER" })).toThrow("ADMIN_ROLE_REQUIRED");
    expect(() => requireAdmin({ userId: "u", email: "u@example.test", role: "OPERATOR" })).toThrow("ADMIN_ROLE_REQUIRED");
  });
});
