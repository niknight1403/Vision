import { PrismaClient } from "@prisma/client";
import { getJournalAccountBalance } from "./journal-service.js";

export type WalletJournalReconciliation = {
  tenantId: string;
  accountId: string;
  currency: string;
  walletBalanceCents: bigint;
  walletReservedCents: bigint;
  walletAvailableCents: bigint;
  ledgerReservedCents: bigint;
  journalAvailableCents: bigint;
  journalReservedCents: bigint;
  differences: Array<{ field: string; expectedCents: bigint; actualCents: bigint }>;
  balanced: boolean;
};

/**
 * Read-only control: compares wallet counters, reservation ledger and journal subaccounts.
 * The journal account codes are deterministic so posting adapters can adopt them later.
 * This function deliberately does not post or mutate financial records.
 */
export function walletJournalAccountCodes(accountId: string) {
  if (!accountId.trim()) throw new Error("WALLET_ACCOUNT_REQUIRED");
  return {
    available: `WALLET:${accountId}:AVAILABLE`,
    reserved: `WALLET:${accountId}:RESERVED`,
  };
}

export async function reconcileWalletJournal(
  prisma: PrismaClient,
  input: { tenantId: string; ownerId: string; accountId: string },
): Promise<WalletJournalReconciliation> {
  if (!input.tenantId.trim() || !input.ownerId.trim() || !input.accountId.trim()) {
    throw new Error("WALLET_RECONCILIATION_SCOPE_REQUIRED");
  }
  const wallet = await prisma.walletAccount.findFirst({
    where: { id: input.accountId, tenantId: input.tenantId, ownerId: input.ownerId },
  });
  if (!wallet) throw new Error("WALLET_NOT_FOUND");

  const ledgerRows = await prisma.walletLedger.findMany({
    where: {
      accountId: wallet.id,
      entryType: { in: ["RESERVATION", "RESERVATION_RELEASE"] },
    },
    select: { entryType: true, amountCents: true },
  });
  const ledgerReservedCents = ledgerRows.reduce((sum, row) =>
    sum + (row.entryType === "RESERVATION" ? row.amountCents : -row.amountCents), 0n);

  const codes = walletJournalAccountCodes(wallet.id);
  const [journalAvailableCents, journalReservedCents] = await Promise.all([
    getJournalAccountBalance(prisma, { tenantId: wallet.tenantId, accountCode: codes.available, currency: wallet.currency }),
    getJournalAccountBalance(prisma, { tenantId: wallet.tenantId, accountCode: codes.reserved, currency: wallet.currency }),
  ]);
  const walletAvailableCents = wallet.balanceCents - wallet.reservedCents;
  const differences = [
    ...(ledgerReservedCents !== wallet.reservedCents
      ? [{ field: "walletReservedVsReservationLedger", expectedCents: wallet.reservedCents, actualCents: ledgerReservedCents }]
      : []),
    ...(journalAvailableCents !== walletAvailableCents
      ? [{ field: "journalAvailableVsWalletAvailable", expectedCents: walletAvailableCents, actualCents: journalAvailableCents }]
      : []),
    ...(journalReservedCents !== wallet.reservedCents
      ? [{ field: "journalReservedVsWalletReserved", expectedCents: wallet.reservedCents, actualCents: journalReservedCents }]
      : []),
  ];
  return {
    tenantId: wallet.tenantId,
    accountId: wallet.id,
    currency: wallet.currency,
    walletBalanceCents: wallet.balanceCents,
    walletReservedCents: wallet.reservedCents,
    walletAvailableCents,
    ledgerReservedCents,
    journalAvailableCents,
    journalReservedCents,
    differences,
    balanced: differences.length === 0,
  };
}
