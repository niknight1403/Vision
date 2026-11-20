import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { releaseFunds, reserveFunds } from "./wallet-service.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!databaseEnabled);
const prisma = new PrismaClient();
let accountId: string;
let ownerId = "";
let tenantId = "";
let ownerSequence = 0;

suite("wallet reservation release invariants (PostgreSQL)", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    ownerSequence += 1;
    const user = await prisma.user.create({ data: {
      email: `wallet-release-${process.pid}-${ownerSequence}@example.test`, passwordHash: "integration-test-hash",
    } });
    ownerId = user.id;
    const tenant = await prisma.tenant.create({ data: { name: "Wallet release test" } });
    tenantId = tenant.id;
    await prisma.tenantMembership.create({ data: { tenantId, userId: ownerId, role: "OWNER" } });
    const account = await prisma.walletAccount.create({
      data: { ownerId, tenantId, currency: "EUR", balanceCents: 20_000n },
    });
    accountId = account.id;
  });

  afterEach(async () => {
    if (accountId) {
      await prisma.walletLedger.deleteMany({ where: { accountId } });
      await prisma.walletAccount.deleteMany({ where: { id: accountId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
      await prisma.user.delete({ where: { id: ownerId } });
    }
  });

  const walletScope = () => ({ ownerId, tenantId });

  it("refuses wallet access with a mismatched tenant or owner", async () => {
    await expect(reserveFunds(prisma, {
      accountId, ownerId: "another-user", tenantId,
      amountCents: 1_000n, referenceId: "wrong-tenant-reservation", description: "must not reserve",
    })).rejects.toThrow("WALLET_NOT_FOUND");
    const account = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.reservedCents).toBe(0n);
    expect(await prisma.walletLedger.count({ where: { accountId } })).toBe(0);
  });

  it("binds an idempotent release to its source reservation", async () => {
    await reserveFunds(prisma, {
      accountId, ...walletScope(), amountCents: 4_000n, referenceId: "reservation-idempotent", description: "test reservation",
    });
    const input = {
      accountId, ...walletScope(), amountCents: 4_000n, referenceId: "release-idempotent",
      reservationReferenceId: "reservation-idempotent", description: "test release",
    };
    const first = await releaseFunds(prisma, input);
    const retry = await releaseFunds(prisma, input);
    expect(first.reservedCents).toBe(0n);
    expect(retry.reservedCents).toBe(0n);
    expect(await prisma.walletLedger.count({ where: { accountId, entryType: "RESERVATION_RELEASE" } })).toBe(1);
    const entry = await prisma.walletLedger.findUniqueOrThrow({ where: { referenceId: input.referenceId } });
    expect(entry.reservationReferenceId).toBe("reservation-idempotent");
  });

  it("supports multiple partial releases up to the original reservation amount", async () => {
    await reserveFunds(prisma, {
      accountId, ...walletScope(), amountCents: 5_000n, referenceId: "reservation-partial", description: "partial release reservation",
    });
    const first = await releaseFunds(prisma, {
      accountId, ...walletScope(), amountCents: 1_500n, referenceId: "release-partial-1",
      reservationReferenceId: "reservation-partial", description: "first partial release",
    });
    expect(first.reservedCents).toBe(3_500n);

    const second = await releaseFunds(prisma, {
      accountId, ...walletScope(), amountCents: 2_000n, referenceId: "release-partial-2",
      reservationReferenceId: "reservation-partial", description: "second partial release",
    });
    expect(second.reservedCents).toBe(1_500n);

    const final = await releaseFunds(prisma, {
      accountId, ...walletScope(), amountCents: 1_500n, referenceId: "release-partial-3",
      reservationReferenceId: "reservation-partial", description: "complete reservation release",
    });
    expect(final.reservedCents).toBe(0n);
    expect(await prisma.walletLedger.count({
      where: { accountId, entryType: "RESERVATION_RELEASE", reservationReferenceId: "reservation-partial" },
    })).toBe(3);
  });

  it("prevents cumulative partial releases from exceeding the original reservation", async () => {
    await reserveFunds(prisma, {
      accountId, ...walletScope(), amountCents: 4_000n, referenceId: "reservation-over-release", description: "reservation",
    });
    await releaseFunds(prisma, {
      accountId, ...walletScope(), amountCents: 2_500n, referenceId: "release-over-1",
      reservationReferenceId: "reservation-over-release", description: "first partial release",
    });
    await expect(releaseFunds(prisma, {
      accountId, ...walletScope(), amountCents: 1_501n, referenceId: "release-over-2",
      reservationReferenceId: "reservation-over-release", description: "over release",
    })).rejects.toThrow("RESERVATION_RELEASE_EXCEEDS_ORIGINAL_AMOUNT");
    const account = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.reservedCents).toBe(1_500n);
  });

  it("prevents a second release from consuming another reservation's reserved funds", async () => {
    await reserveFunds(prisma, {
      accountId, ...walletScope(), amountCents: 4_000n, referenceId: "reservation-a", description: "reservation A",
    });
    await reserveFunds(prisma, {
      accountId, ...walletScope(), amountCents: 5_000n, referenceId: "reservation-b", description: "reservation B",
    });
    await releaseFunds(prisma, {
      accountId, ...walletScope(), amountCents: 4_000n, referenceId: "release-a-1",
      reservationReferenceId: "reservation-a", description: "first release A",
    });

    await expect(releaseFunds(prisma, {
      accountId, ...walletScope(), amountCents: 1n, referenceId: "release-a-2",
      reservationReferenceId: "reservation-a", description: "duplicate release A",
    })).rejects.toThrow("RESERVATION_RELEASE_EXCEEDS_ORIGINAL_AMOUNT");

    const account = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.reservedCents).toBe(5_000n);
  });

  it("rejects releases that point to a different account or a non-reservation source", async () => {
    await reserveFunds(prisma, {
      accountId, ...walletScope(), amountCents: 3_000n, referenceId: "reservation-mismatch", description: "reservation",
    });
    await expect(releaseFunds(prisma, {
      accountId, ...walletScope(), amountCents: 2_000n, referenceId: "release-mismatch",
      reservationReferenceId: "reservation-does-not-exist", description: "mismatched source",
    })).rejects.toThrow("ORIGINAL_RESERVATION_NOT_FOUND_OR_MISMATCHED");
  });

  it("allows at most one concurrent full release", async () => {
    await reserveFunds(prisma, {
      accountId, ...walletScope(), amountCents: 2_000n, referenceId: "reservation-race", description: "reservation",
    });
    const results = await Promise.allSettled([
      releaseFunds(prisma, {
        accountId, ...walletScope(), amountCents: 2_000n, referenceId: "release-race-a",
        reservationReferenceId: "reservation-race", description: "release A",
      }),
      releaseFunds(prisma, {
        accountId, ...walletScope(), amountCents: 2_000n, referenceId: "release-race-b",
        reservationReferenceId: "reservation-race", description: "release B",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.walletLedger.count({ where: { accountId, entryType: "RESERVATION_RELEASE" } })).toBe(1);
    const account = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.reservedCents).toBe(0n);
  });
});

if (!databaseEnabled) {
  // Keep the shared Prisma client from opening a handle when the integration suite is skipped.
  void prisma.$disconnect();
}
