import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export type JournalLineInput = {
  accountCode: string;
  debitCents?: bigint;
  creditCents?: bigint;
};

export type PostJournalInput = {
  tenantId: string;
  referenceId: string;
  currency: string;
  description: string;
  entries: JournalLineInput[];
};

function normalize(input: PostJournalInput) {
  if (!input.tenantId.trim() || !input.referenceId.trim() || !input.description.trim()) {
    throw new Error("JOURNAL_REQUIRED_FIELDS_MISSING");
  }
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("INVALID_JOURNAL_CURRENCY");
  if (!Array.isArray(input.entries) || input.entries.length < 2) {
    throw new Error("JOURNAL_REQUIRES_TWO_OR_MORE_ENTRIES");
  }
  const entries = input.entries.map((line) => {
    const accountCode = line.accountCode.trim();
    const debitCents = line.debitCents ?? 0n;
    const creditCents = line.creditCents ?? 0n;
    if (!accountCode || accountCode.length > 64) throw new Error("INVALID_JOURNAL_ACCOUNT_CODE");
    if (debitCents < 0n || creditCents < 0n || (debitCents > 0n) === (creditCents > 0n)) {
      throw new Error("JOURNAL_LINE_MUST_HAVE_ONE_POSITIVE_SIDE");
    }
    return { accountCode, debitCents, creditCents };
  });
  const debitTotal = entries.reduce((sum, line) => sum + line.debitCents, 0n);
  const creditTotal = entries.reduce((sum, line) => sum + line.creditCents, 0n);
  if (debitTotal === 0n || debitTotal !== creditTotal) throw new Error("JOURNAL_NOT_BALANCED");
  const canonicalEntries = [...entries].sort((a, b) =>
    a.accountCode.localeCompare(b.accountCode) ||
    (a.debitCents < b.debitCents ? -1 : a.debitCents > b.debitCents ? 1 : 0) ||
    (a.creditCents < b.creditCents ? -1 : a.creditCents > b.creditCents ? 1 : 0));
  const canonical = {
    tenantId: input.tenantId,
    referenceId: input.referenceId.trim(),
    currency,
    description: input.description.trim(),
    entries: canonicalEntries.map((line) => ({
      accountCode: line.accountCode,
      debitCents: line.debitCents.toString(),
      creditCents: line.creditCents.toString(),
    })),
  };
  const payloadHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return { ...canonical, entries, payloadHash };
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function postJournalTransaction(prisma: PrismaClient, input: PostJournalInput) {
  const normalized = normalize(input);
  const findExisting = (db: Db) => db.journalTransaction.findUnique({
    where: { tenantId_referenceId: { tenantId: normalized.tenantId, referenceId: normalized.referenceId } },
    include: { entries: true },
  });
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await findExisting(tx);
      if (existing) {
        if (existing.payloadHash !== normalized.payloadHash) throw new Error("JOURNAL_IDEMPOTENCY_CONFLICT");
        return existing;
      }
      return tx.journalTransaction.create({
        data: {
          tenantId: normalized.tenantId,
          referenceId: normalized.referenceId,
          currency: normalized.currency,
          description: normalized.description,
          payloadHash: normalized.payloadHash,
          entries: { create: normalized.entries },
        },
        include: { entries: true },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isUniqueConflict(error)) {
      const concurrent = await findExisting(prisma);
      if (concurrent?.payloadHash === normalized.payloadHash) return concurrent;
      if (concurrent) throw new Error("JOURNAL_IDEMPOTENCY_CONFLICT");
    }
    throw error;
  }
}

export async function getJournalAccountBalance(
  prisma: Db,
  input: { tenantId: string; accountCode: string; currency: string },
): Promise<bigint> {
  if (!input.tenantId.trim() || !input.accountCode.trim()) throw new Error("JOURNAL_ACCOUNT_SCOPE_REQUIRED");
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("INVALID_JOURNAL_CURRENCY");
  const totals = await prisma.journalEntry.aggregate({
    where: {
      accountCode: input.accountCode.trim(),
      transaction: { tenantId: input.tenantId, currency },
    },
    _sum: { debitCents: true, creditCents: true },
  });
  return (totals._sum.debitCents ?? 0n) - (totals._sum.creditCents ?? 0n);
}

export async function reconcileJournal(
  prisma: Db,
  input: { tenantId: string; from?: Date; to?: Date },
) {
  if (!input.tenantId.trim()) throw new Error("JOURNAL_TENANT_REQUIRED");
  if (input.from && input.to && input.from > input.to) throw new Error("INVALID_RECONCILIATION_RANGE");
  const transactions = await prisma.journalTransaction.findMany({
    where: {
      tenantId: input.tenantId,
      ...(input.from || input.to ? { createdAt: {
        ...(input.from ? { gte: input.from } : {}),
        ...(input.to ? { lte: input.to } : {}),
      } } : {}),
    },
    include: { entries: true },
    orderBy: { createdAt: "asc" },
  });
  const imbalances = transactions.flatMap((transaction) => {
    const debit = transaction.entries.reduce((sum, line) => sum + line.debitCents, 0n);
    const credit = transaction.entries.reduce((sum, line) => sum + line.creditCents, 0n);
    return debit === credit && debit > 0n && transaction.entries.length >= 2
      ? []
      : [{ transactionId: transaction.id, referenceId: transaction.referenceId, debitCents: debit, creditCents: credit }];
  });
  return {
    tenantId: input.tenantId,
    checkedTransactions: transactions.length,
    balanced: imbalances.length === 0,
    imbalances,
  };
}
