import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { bootstrapAdmin } from "./admin-bootstrap.js";

const password = "a-unique-bootstrap-password";

describe("initial administrator bootstrap", () => {
  it("creates only the approved administrator with a password hash", async () => {
    const create = vi.fn().mockResolvedValue({ id: "admin-1" });
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create,
      },
    } as unknown as PrismaClient;

    await expect(bootstrapAdmin(prisma, {
      ADMIN_BOOTSTRAP_EMAIL: "Niko.oeben@gmail.com",
      ADMIN_BOOTSTRAP_PASSWORD: password,
    })).resolves.toBe("created");

    const data = create.mock.calls[0]![0].data as { email: string; role: string; passwordHash: string };
    expect(data.email).toBe("niko.oeben@gmail.com");
    expect(data.role).toBe("ADMIN");
    expect(data.passwordHash).not.toBe(password);
    expect(data.passwordHash.startsWith("scrypt$")).toBe(true);
  });

  it("rejects any email other than the approved administrator", async () => {
    const prisma = { user: { findUnique: vi.fn(), create: vi.fn() } } as unknown as PrismaClient;
    await expect(bootstrapAdmin(prisma, {
      ADMIN_BOOTSTRAP_EMAIL: "attacker@example.test",
      ADMIN_BOOTSTRAP_PASSWORD: password,
    })).rejects.toThrow("ADMIN_BOOTSTRAP_EMAIL_MUST_MATCH_APPROVED_ADMIN");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("fails closed when the account already exists with a non-admin role", async () => {
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: "existing", role: "VIEWER", disabledAt: null }),
        create: vi.fn(),
      },
    } as unknown as PrismaClient;
    await expect(bootstrapAdmin(prisma, {
      ADMIN_BOOTSTRAP_EMAIL: "niko.oeben@gmail.com",
      ADMIN_BOOTSTRAP_PASSWORD: password,
    })).rejects.toThrow("ADMIN_BOOTSTRAP_ACCOUNT_EXISTS_REQUIRES_MANUAL_REVIEW");
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
