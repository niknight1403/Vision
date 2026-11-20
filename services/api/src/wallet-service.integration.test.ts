import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { releaseFunds, reserveFunds } from "./wallet-service.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!databaseEnabled);
const prisma = new PrismaClient();
let accountId: string;
let ownerId: string;
let ownerSequence = 0;

suite("wallet reservation release invariants (PostgreSQL)", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    ownerSequence += 1;
    ownerId = `wallet-release-test-${process.pid}-${ownerSequence}`;
    const account = await prisma.walletAccount.create({
      data: { ownerId, currency: "EUR", balanceCents: 20_000n },
    });
    accountId = account.id;
  });

  afterEach(async () => {
    if (accountId) {
      await prisma.walletLedger.deleteMany({ where: { accountId } });
      await prisma.walletAccount.deleteMany({ where: { id: accountId } });
    }
  });

  it("rejects wallet operations when the caller does not own the account", async () => {
    await expect(reserveFunds(prisma, {
      accountId, ownerId: ownerId + "-other", amountCents: 1_000n,
      referenceId: "reservation-wrong-owner", description: "wrong owner",
    })).rejects.toThrow("WALLET_NOT_FOUND");
    await expect(releaseFunds(prisma, {
      accountId, ownerId: ownerId + "-other", amountCents: 1_000n,
      referenceId: "release-wrong-owner", reservationReferenceId: "missing-reservation",
      description: "wrong owner",
    })).rejects.toThrow("WALLET_NOT_FOUND");
    const account = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.reservedCents).toBe(0n);
    expect(await prisma.walletLedger.count({ where: { accountId } })).toBe(0);
  });

  it("binds an idempotent release to its source reservation", async () => {
    await reserveFunds(prisma, {
      accountId, ownerId, amountCents: 4_000n, referenceId: "reservation-idempotent", description: "test reservation",
    });
    const input = {
      accountId, ownerId, amountCents: 4_000n, referenceId: "release-idempotent",
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

  it("prevents a second release from consuming another reservation's reserved funds", async () => {
    await reserveFunds(prisma, {
      accountId, ownerId, amountCents: 4_000n, referenceId: "reservation-a", description: "reservation A",
    });
    await reserveFunds(prisma, {
      accountId, ownerId, amountCents: 5_000n, referenceId: "reservation-b", description: "reservation B",
    });
    await releaseFunds(prisma, {
      accountId, ownerId, amountCents: 4_000n, referenceId: "release-a-1",
      reservationReferenceId: "reservation-a", description: "first release A",
    });

    await expect(releaseFunds(prisma, {
      accountId, ownerId, amountCents: 4_000n, referenceId: "release-a-2",
      reservationReferenceId: "reservation-a", description: "duplicate release A",
    })).rejects.toThrow("RESERVATION_RELEASE_EXCEEDS_ORIGINAL_AMOUNT");

    const account = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.reservedCents).toBe(5_000n);
  });

  it("rejects releases that point to a different account or amount", async () => {
    await reserveFunds(prisma, {
      accountId, ownerId, amountCents: 3_000n, referenceId: "reservation-mismatch", description: "reservation",
    });
    await expect(releaseFunds(prisma, {
      accountId, ownerId, amountCents: 2_000n, referenceId: "release-mismatch",
      reservationReferenceId: "reservation-mismatch", description: "mismatched partial release",
    })).rejects.toThrow("ORIGINAL_RESERVATION_NOT_FOUND_OR_MISMATCHED");
  });

  it("allows at most one concurrent full release", async () => {
    await reserveFunds(prisma, {
      accountId, ownerId, amountCents: 2_000n, referenceId: "reservation-race", description: "reservation",
    });
    const results = await Promise.allSettled([
      releaseFunds(prisma, {
        accountId, ownerId, amountCents: 2_000n, referenceId: "release-race-a",
        reservationReferenceId: "reservation-race", description: "release A",
      }),
      releaseFunds(prisma, {
        accountId, ownerId, amountCents: 2_000n, referenceId: "release-race-b",
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
