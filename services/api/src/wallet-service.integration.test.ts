import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { postJournalTransactionInTransaction } from "./journal-service.js";
import { enqueueOutboxEvent } from "./outbox-service.js";
import { runSerializableTransaction } from "./transaction-retry.js";
import { releaseFunds, releaseFundsInTransaction, reserveFunds, reserveFundsInTransaction } from "./wallet-service.js";

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
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: accountId } });
      await prisma.walletLedger.deleteMany({ where: { accountId } });
      await prisma.walletAccount.deleteMany({ where: { id: accountId } });
      await prisma.tenantMembership.deleteMany({ where: { tenantId, userId: ownerId } });
      const hasImmutableJournal = await prisma.journalTransaction.count({ where: { tenantId } });
      if (hasImmutableJournal === 0) {
        await prisma.tenant.delete({ where: { id: tenantId } });
      }
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

  it("writes reservation and release outbox events atomically and idempotently", async () => {
    const reservation = {
      accountId, ...walletScope(), amountCents: 2_000n,
      referenceId: "reservation-outbox-atomic", correlationId: "wallet-outbox-test",
      description: "outbox reservation",
    };
    await reserveFunds(prisma, reservation);
    await reserveFunds(prisma, reservation);
    expect(await prisma.outboxEvent.count({
      where: { aggregateId: accountId, eventType: "wallet.reservation.created" },
    })).toBe(1);

    const release = {
      accountId, ...walletScope(), amountCents: 1_000n,
      referenceId: "release-outbox-atomic", reservationReferenceId: reservation.referenceId,
      correlationId: "wallet-outbox-test", description: "outbox partial release",
    };
    await releaseFunds(prisma, release);
    await releaseFunds(prisma, release);
    expect(await prisma.outboxEvent.count({
      where: { aggregateId: accountId, eventType: "wallet.reservation.released" },
    })).toBe(1);
    const account = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.reservedCents).toBe(1_000n);
  });

  it("composes wallet, journal, and outbox writes in one caller-owned transaction", async () => {
    const referenceId = "wallet-journal-atomic-commit";
    const reserveInput = {
      accountId, ...walletScope(), amountCents: 1_000n,
      referenceId, correlationId: referenceId, description: "transaction composition test",
    };

    await expect(runSerializableTransaction(prisma, async (tx) => {
      await reserveFundsInTransaction(tx, {
        ...reserveInput, referenceId: "wallet-journal-atomic-rollback",
      });
      const journal = await postJournalTransactionInTransaction(tx, {
        tenantId, referenceId: "wallet-journal-atomic-rollback", currency: "EUR",
        description: "technical transaction composition test only",
        entries: [
          { accountCode: "TEST-COMPOSITION-DEBIT", debitCents: 1_000n },
          { accountCode: "TEST-COMPOSITION-CREDIT", creditCents: 1_000n },
        ],
      });
      await enqueueOutboxEvent(tx, {
        eventType: "test.wallet-journal.composed",
        aggregateId: accountId,
        correlationId: "wallet-journal-atomic-rollback",
        payload: { journalTransactionId: journal.id },
      });
      throw new Error("FORCE_COMPOSED_TRANSACTION_ROLLBACK");
    }, { baseDelayMs: 0 })).rejects.toThrow("FORCE_COMPOSED_TRANSACTION_ROLLBACK");

    expect((await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } })).reservedCents).toBe(0n);
    expect(await prisma.walletLedger.count({ where: { referenceId: "wallet-journal-atomic-rollback" } })).toBe(0);
    expect(await prisma.journalTransaction.count({ where: { tenantId, referenceId: "wallet-journal-atomic-rollback" } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { correlationId: "wallet-journal-atomic-rollback" } })).toBe(0);

    await runSerializableTransaction(prisma, async (tx) => {
      await reserveFundsInTransaction(tx, reserveInput);
      const journal = await postJournalTransactionInTransaction(tx, {
        tenantId, referenceId: "wallet-journal-atomic-commit", currency: "EUR",
        description: "technical transaction composition test only",
        entries: [
          { accountCode: "TEST-COMPOSITION-DEBIT", debitCents: 1_000n },
          { accountCode: "TEST-COMPOSITION-CREDIT", creditCents: 1_000n },
        ],
      });
      await enqueueOutboxEvent(tx, {
        eventType: "test.wallet-journal.composed",
        aggregateId: accountId,
        correlationId: "wallet-journal-atomic-commit",
        payload: { journalTransactionId: journal.id },
      });
    }, { baseDelayMs: 0 });

    expect((await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } })).reservedCents).toBe(1_000n);
    expect(await prisma.walletLedger.count({ where: { referenceId } })).toBe(1);
    expect(await prisma.journalTransaction.count({ where: { tenantId, referenceId } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { correlationId: referenceId } })).toBe(2);
  });

  it("supports reservation release inside a caller-owned transaction", async () => {
    await reserveFunds(prisma, {
      accountId, ...walletScope(), amountCents: 1_200n,
      referenceId: "wallet-release-composition-source", description: "release composition source",
    });
    const before = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    await prisma.$transaction(async (tx) => {
      await releaseFundsInTransaction(tx, {
        accountId, ...walletScope(), amountCents: 700n,
        referenceId: "wallet-release-composition-inner",
        reservationReferenceId: "wallet-release-composition-source",
        description: "caller-owned partial release",
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const after = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(before.reservedCents - after.reservedCents).toBe(700n);
    expect(await prisma.outboxEvent.count({
      where: { aggregateId: accountId, eventType: "wallet.reservation.released", correlationId: "wallet-release-composition-inner" },
    })).toBe(1);
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

  it("deduplicates concurrent reservations with the same idempotency key", async () => {
    const input = {
      accountId, ...walletScope(), amountCents: 2_500n,
      referenceId: "reservation-concurrent-idempotent",
      description: "concurrent idempotent reservation",
    };
    const results = await Promise.allSettled([
      reserveFunds(prisma, input),
      reserveFunds(prisma, input),
    ]);

    expect(results.map((result) => result.status === "fulfilled" ? "fulfilled" : String(result.reason))).toEqual(["fulfilled", "fulfilled"]);
    expect(await prisma.walletLedger.count({
      where: { accountId, referenceId: input.referenceId, entryType: "RESERVATION" },
    })).toBe(1);
    expect(await prisma.outboxEvent.count({
      where: { aggregateId: accountId, eventType: "wallet.reservation.created", correlationId: input.referenceId },
    })).toBe(1);
    const wallet = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(wallet.reservedCents).toBe(input.amountCents);
  });

  it("rejects concurrent reservations that reuse an idempotency key with different payloads", async () => {
    const common = {
      accountId, ...walletScope(), referenceId: "reservation-concurrent-conflict",
    };
    const results = await Promise.allSettled([
      reserveFunds(prisma, { ...common, amountCents: 1_500n, description: "payload A" }),
      reserveFunds(prisma, { ...common, amountCents: 2_000n, description: "payload B" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const ledger = await prisma.walletLedger.findUniqueOrThrow({
      where: { referenceId: common.referenceId },
    });
    expect([1_500n, 2_000n]).toContain(ledger.amountCents);
    const wallet = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(wallet.reservedCents).toBe(ledger.amountCents);
    expect(await prisma.outboxEvent.count({
      where: { aggregateId: accountId, eventType: "wallet.reservation.created", correlationId: common.referenceId },
    })).toBe(1);
  });

  it("rejects reuse of a wallet idempotency key across tenant accounts", async () => {
    const otherTenant = await prisma.tenant.create({ data: { name: "Second wallet tenant" } });
    const otherAccount = await prisma.walletAccount.create({
      data: { ownerId: "second-tenant-owner", tenantId: otherTenant.id, currency: "EUR", balanceCents: 10_000n },
    });
    const referenceId = "wallet-global-idempotency-scope";
    try {
      await reserveFunds(prisma, {
        accountId, ...walletScope(), amountCents: 1_000n, referenceId,
        description: "first tenant reservation",
      });
      await expect(reserveFunds(prisma, {
        accountId: otherAccount.id, ownerId: "second-tenant-owner", tenantId: otherTenant.id,
        amountCents: 1_000n, referenceId, description: "second tenant reservation",
      })).rejects.toThrow("IDEMPOTENCY_CONFLICT");

      expect(await prisma.walletLedger.count({ where: { referenceId } })).toBe(1);
      expect((await prisma.walletAccount.findUniqueOrThrow({ where: { id: otherAccount.id } })).reservedCents).toBe(0n);
    } finally {
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: otherAccount.id } });
      await prisma.walletLedger.deleteMany({ where: { accountId: otherAccount.id } });
      await prisma.walletAccount.delete({ where: { id: otherAccount.id } });
      await prisma.tenant.delete({ where: { id: otherTenant.id } });
    }
  });

  it("deduplicates concurrent identical partial releases", async () => {
    await reserveFunds(prisma, {
      accountId, ...walletScope(), amountCents: 4_000n,
      referenceId: "reservation-concurrent-release-idempotent",
      description: "concurrent release source",
    });
    const input = {
      accountId, ...walletScope(), amountCents: 1_500n,
      referenceId: "release-concurrent-idempotent",
      reservationReferenceId: "reservation-concurrent-release-idempotent",
      description: "concurrent identical partial release",
    };
    const results = await Promise.allSettled([
      releaseFunds(prisma, input),
      releaseFunds(prisma, input),
    ]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await prisma.walletLedger.count({
      where: { accountId, referenceId: input.referenceId, entryType: "RESERVATION_RELEASE" },
    })).toBe(1);
    expect(await prisma.outboxEvent.count({
      where: { aggregateId: accountId, eventType: "wallet.reservation.released", correlationId: input.referenceId },
    })).toBe(1);
    const account = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.reservedCents).toBe(2_500n);
  });

  it("serializes concurrent distinct partial releases against the source reservation limit", async () => {
    await reserveFunds(prisma, {
      accountId, ...walletScope(), amountCents: 4_000n,
      referenceId: "reservation-concurrent-partial-limit",
      description: "concurrent partial release limit source",
    });
    const common = {
      accountId, ...walletScope(), amountCents: 2_500n,
      reservationReferenceId: "reservation-concurrent-partial-limit",
    };
    const results = await Promise.allSettled([
      releaseFunds(prisma, {
        ...common, referenceId: "release-concurrent-partial-a",
        description: "concurrent partial release A",
      }),
      releaseFunds(prisma, {
        ...common, referenceId: "release-concurrent-partial-b",
        description: "concurrent partial release B",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const releases = await prisma.walletLedger.findMany({
      where: {
        accountId, entryType: "RESERVATION_RELEASE",
        reservationReferenceId: common.reservationReferenceId,
      },
    });
    expect(releases).toHaveLength(1);
    expect(releases[0]?.amountCents).toBe(2_500n);
    expect(await prisma.outboxEvent.count({
      where: {
        aggregateId: accountId, eventType: "wallet.reservation.released",
        correlationId: { in: ["release-concurrent-partial-a", "release-concurrent-partial-b"] },
      },
    })).toBe(1);
    const account = await prisma.walletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.reservedCents).toBe(1_500n);
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
