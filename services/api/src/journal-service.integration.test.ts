import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { getJournalAccountBalance, postJournalTransaction, postJournalTransactionInTransaction, reconcileJournal } from "./journal-service.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!databaseEnabled);
const prisma = new PrismaClient();
let tenantId = "";
let otherTenantId = "";

suite("double-entry journal (PostgreSQL)", () => {
  beforeAll(async () => {
    await prisma.$connect();
    const [tenant, other] = await Promise.all([
      prisma.tenant.create({ data: { name: "Journal integration tenant" } }),
      prisma.tenant.create({ data: { name: "Journal isolation tenant" } }),
    ]);
    tenantId = tenant.id;
    otherTenantId = other.id;
  });

  afterAll(async () => {
    // The CI database is ephemeral. Keep posted rows intact to exercise append-only semantics.
    await prisma.$disconnect();
  });

  function posting(referenceId: string) {
    return {
      tenantId, referenceId, currency: "EUR", description: "Integration test journal posting",
      entries: [
        { accountCode: "1000-CASH", debitCents: 12_500n },
        { accountCode: "4000-SALES", creditCents: 12_500n },
      ],
    };
  }

  it("rejects unbalanced and malformed entries before writing", async () => {
    await expect(postJournalTransaction(prisma, {
      ...posting("journal-unbalanced"),
      entries: [
        { accountCode: "1000-CASH", debitCents: 100n },
        { accountCode: "4000-SALES", creditCents: 99n },
      ],
    })).rejects.toThrow("JOURNAL_NOT_BALANCED");
    await expect(postJournalTransaction(prisma, {
      ...posting("journal-invalid-side"),
      entries: [
        { accountCode: "1000-CASH", debitCents: 100n, creditCents: 100n },
        { accountCode: "4000-SALES", creditCents: 100n },
      ],
    })).rejects.toThrow("JOURNAL_LINE_MUST_HAVE_ONE_POSITIVE_SIDE");
    expect(await prisma.journalTransaction.count({ where: { tenantId } })).toBe(0);
  });

  it("rejects a journal header that is not finalized with balanced entries at commit", async () => {
    await expect(prisma.$transaction(async (tx) => {
      await tx.journalTransaction.create({
        data: {
          tenantId,
          referenceId: "journal-unfinalized-header",
          currency: "EUR",
          description: "must fail at commit",
          payloadHash: "a".repeat(64),
        },
      });
    })).rejects.toThrow();
    expect(await prisma.journalTransaction.count({
      where: { tenantId, referenceId: "journal-unfinalized-header" },
    })).toBe(0);
  });

  it("posts atomically and returns the same transaction for an identical retry", async () => {
    const input = posting("journal-idempotent");
    const first = await postJournalTransaction(prisma, input);
    const retry = await postJournalTransaction(prisma, input);
    expect(retry.id).toBe(first.id);
    expect(first.entries).toHaveLength(2);
    expect(first.entries.reduce((sum, line) => sum + line.debitCents, 0n)).toBe(12_500n);
    expect(first.entries.reduce((sum, line) => sum + line.creditCents, 0n)).toBe(12_500n);
    await expect(postJournalTransaction(prisma, {
      ...input, entries: [
        { accountCode: "1000-CASH", debitCents: 13_000n },
        { accountCode: "4000-SALES", creditCents: 13_000n },
      ],
    })).rejects.toThrow("JOURNAL_IDEMPOTENCY_CONFLICT");
    expect(await prisma.journalTransaction.count({ where: { tenantId, referenceId: input.referenceId } })).toBe(1);
  });

  it("participates in a caller-owned transaction and rolls back with it", async () => {
    const rollbackInput = posting("journal-caller-rollback");
    await expect(prisma.$transaction(async (tx) => {
      await postJournalTransactionInTransaction(tx, rollbackInput);
      throw new Error("FORCE_OUTER_ROLLBACK");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).rejects.toThrow("FORCE_OUTER_ROLLBACK");
    expect(await prisma.journalTransaction.count({
      where: { tenantId, referenceId: rollbackInput.referenceId },
    })).toBe(0);

    const committedInput = posting("journal-caller-commit");
    const posted = await prisma.$transaction(
      (tx) => postJournalTransactionInTransaction(tx, committedInput),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    expect(posted.entries).toHaveLength(2);
    expect(await prisma.journalTransaction.count({
      where: { tenantId, referenceId: committedInput.referenceId },
    })).toBe(1);
  });

  it("deduplicates concurrent identical postings under serializable isolation", async () => {
    const input = posting("journal-concurrent-idempotent");
    const [first, second] = await Promise.all([
      postJournalTransaction(prisma, input),
      postJournalTransaction(prisma, input),
    ]);
    expect(first.id).toBe(second.id);
    expect(await prisma.journalTransaction.count({
      where: { tenantId, referenceId: input.referenceId },
    })).toBe(1);
  });

  it("prevents updates, deletes, late inserts, and truncation of posted journal records", async () => {
    const transaction = await postJournalTransaction(prisma, posting("journal-immutable"));
    await expect(prisma.journalEntry.updateMany({
      where: { transactionId: transaction.id }, data: { debitCents: 1n },
    })).rejects.toThrow();
    await expect(prisma.journalEntry.deleteMany({
      where: { transactionId: transaction.id },
    })).rejects.toThrow();
    await expect(prisma.journalTransaction.update({
      where: { id: transaction.id }, data: { description: "tampered" },
    })).rejects.toThrow();
    await expect(prisma.journalEntry.create({
      data: {
        transactionId: transaction.id,
        accountCode: "9999-LATE-INSERT",
        debitCents: 1n,
        creditCents: 0n,
      },
    })).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "JournalEntry"')).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "JournalTransaction"')).rejects.toThrow();
    expect(await prisma.journalEntry.count({ where: { transactionId: transaction.id } })).toBe(2);
  });

  it("calculates account balances and isolates them by tenant", async () => {
    const input = {
      ...posting("journal-balance"),
      entries: [
        { accountCode: "BALANCE-CASH", debitCents: 12_500n },
        { accountCode: "BALANCE-SALES", creditCents: 12_500n },
      ],
    };
    await postJournalTransaction(prisma, input);
    const [cash, sales, otherTenantCash] = await Promise.all([
      getJournalAccountBalance(prisma, { tenantId, accountCode: "BALANCE-CASH", currency: "EUR" }),
      getJournalAccountBalance(prisma, { tenantId, accountCode: "BALANCE-SALES", currency: "EUR" }),
      getJournalAccountBalance(prisma, { tenantId: otherTenantId, accountCode: "BALANCE-CASH", currency: "EUR" }),
    ]);
    expect(cash).toBe(12_500n);
    expect(sales).toBe(-12_500n);
    expect(otherTenantCash).toBe(0n);
  });

  it("reconciles every tenant transaction and reports a clean result", async () => {
    await postJournalTransaction(prisma, posting("journal-reconcile"));
    const result = await reconcileJournal(prisma, { tenantId });
    expect(result.balanced).toBe(true);
    expect(result.imbalances).toHaveLength(0);
    expect(result.checkedTransactions).toBeGreaterThanOrEqual(1);
  });

  it("rejects invalid reconciliation ranges", async () => {
    await expect(reconcileJournal(prisma, {
      tenantId, from: new Date("2026-12-01T00:00:00.000Z"), to: new Date("2026-11-01T00:00:00.000Z"),
    })).rejects.toThrow("INVALID_RECONCILIATION_RANGE");
  });
});

if (!databaseEnabled) void prisma.$disconnect();
