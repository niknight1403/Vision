import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  hashPassword,
  loginWithPassword,
  verifyPassword,
} from "./auth-session-service.js";

const secret = "test-signing-secret-with-more-than-thirty-two-bytes";

describe("password and session primitives", () => {
  it("hashes passwords with per-password salt and verifies without storing plaintext", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");
    expect(first).not.toBe(second);
    expect(first).not.toContain("correct horse");
    await expect(verifyPassword("correct horse battery staple", first)).resolves.toBe(true);
    await expect(verifyPassword("incorrect password", first)).resolves.toBe(false);
    await expect(hashPassword("short")).rejects.toThrow("PASSWORD_POLICY_VIOLATION");
  });

  it("issues an access token and stores only a hash of a random refresh token", async () => {
    const create = vi.fn().mockResolvedValue({ id: "session-1" });
    const findUnique = vi.fn().mockResolvedValue({
      id: "user-1",
      passwordHash: await hashPassword("correct horse battery staple"),
      disabledAt: null,
    });
    const prisma = {
      user: { findUnique },
      refreshSession: { create },
    } as unknown as PrismaClient;

    const pair = await loginWithPassword(
      prisma,
      { email: " ADMIN@example.test ", password: "correct horse battery staple" },
      secret,
      new Date("2026-11-17T12:00:00.000Z"),
    );

    expect(pair.tokenType).toBe("Bearer");
    expect(pair.accessToken.split(".")).toHaveLength(3);
    expect(pair.refreshToken.length).toBeGreaterThan(40);
    expect(pair.refreshTokenExpiresAt).toBe("2026-12-17T12:00:00.000Z");
    expect(create).toHaveBeenCalledTimes(1);
    const stored = create.mock.calls[0]![0] as { data: { tokenHash: string; userId: string } };
    expect(stored.data.userId).toBe("user-1");
    expect(stored.data.tokenHash).not.toBe(pair.refreshToken);
    expect(stored.data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses one generic error for unknown accounts and wrong passwords", async () => {
    const missing = {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      refreshSession: { create: vi.fn() },
    } as unknown as PrismaClient;
    await expect(loginWithPassword(missing, { email: "missing@example.test", password: "a sufficiently long password" }, secret))
      .rejects.toThrow("INVALID_CREDENTIALS");

    const disabled = {
      user: { findUnique: vi.fn().mockResolvedValue({
        id: "user-2",
        passwordHash: await hashPassword("correct horse battery staple"),
        disabledAt: new Date(),
      }) },
      refreshSession: { create: vi.fn() },
    } as unknown as PrismaClient;
    await expect(loginWithPassword(disabled, { email: "disabled@example.test", password: "correct horse battery staple" }, secret))
      .rejects.toThrow("INVALID_CREDENTIALS");
  });
});
