import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getJournalAccountBalance, postJournalTransaction, reconcileJournal } from "./journal-service.js";

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

  it("prevents updates and deletes to posted journal records", async () => {
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
  });

  it("calculates account balances and isolates them by tenant", async () => {
    const input = {
      ...posting("journal-balance"),
      entries: [
        { accountCode: "BALANCE-CASH", debitCents: 12_500n },
        { accountCode: "BALANCE-SALES", creditCents: 12_500n },
      ],
    };
    const transaction = await postJournalTransaction(prisma, input);
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
    const input = posting("journal-reconcile");
    const transaction = await postJournalTransaction(prisma, input);
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
