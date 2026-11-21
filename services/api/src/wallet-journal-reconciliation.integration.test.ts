import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postJournalTransaction } from "./journal-service.js";
import { reconcileWalletJournal, walletJournalAccountCodes } from "./wallet-journal-reconciliation.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!databaseEnabled);
const prisma = new PrismaClient();

suite("wallet-to-journal reconciliation (PostgreSQL)", () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("reconciles wallet counters, reservation ledger and journal subaccounts", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Wallet journal reconciliation test" } });
    const wallet = await prisma.walletAccount.create({
      data: { tenantId: tenant.id, ownerId: "wallet-journal-test-owner", currency: "EUR", balanceCents: 20_000n, reservedCents: 4_000n },
    });
    await prisma.walletLedger.create({
      data: {
        accountId: wallet.id, entryType: "RESERVATION", amountCents: 4_000n,
        referenceId: `wallet-journal-reservation-${wallet.id}`, description: "reconciliation fixture",
      },
    });
    const codes = walletJournalAccountCodes(wallet.id);
    await postJournalTransaction(prisma, {
      tenantId: tenant.id, referenceId: `wallet-journal-opening-${wallet.id}`,
      currency: "EUR", description: "Wallet opening subaccount balances",
      entries: [
        { accountCode: codes.available, debitCents: 16_000n },
        { accountCode: codes.reserved, debitCents: 4_000n },
        { accountCode: `WALLET:${wallet.id}:CLEARING`, creditCents: 20_000n },
      ],
    });

    const walletBefore = await prisma.walletAccount.findUniqueOrThrow({ where: { id: wallet.id } });
    const ledgerBefore = await prisma.walletLedger.findMany({ where: { accountId: wallet.id }, orderBy: { id: "asc" } });
    const journalBefore = await prisma.journalTransaction.count({ where: { tenantId: tenant.id } });

    const result = await reconcileWalletJournal(prisma, {
      tenantId: tenant.id, ownerId: wallet.ownerId, accountId: wallet.id,
    });

    const walletAfter = await prisma.walletAccount.findUniqueOrThrow({ where: { id: wallet.id } });
    const ledgerAfter = await prisma.walletLedger.findMany({ where: { accountId: wallet.id }, orderBy: { id: "asc" } });
    const journalAfter = await prisma.journalTransaction.count({ where: { tenantId: tenant.id } });
    expect(walletAfter).toEqual(walletBefore);
    expect(ledgerAfter).toEqual(ledgerBefore);
    expect(journalAfter).toBe(journalBefore);
    expect(result.balanced).toBe(true);
    expect(result.ledgerReservedCents).toBe(4_000n);
    expect(result.journalAvailableCents).toBe(16_000n);
    expect(result.journalReservedCents).toBe(4_000n);

    await prisma.walletAccount.update({
      where: { id: wallet.id }, data: { reservedCents: 5_000n },
    });
    const drift = await reconcileWalletJournal(prisma, {
      tenantId: tenant.id, ownerId: wallet.ownerId, accountId: wallet.id,
    });
    expect(drift.balanced).toBe(false);
    expect(drift.differences.map((item) => item.field)).toContain("walletReservedVsReservationLedger");
    expect(drift.differences.map((item) => item.field)).toContain("journalReservedVsWalletReserved");
  });

  it("rejects an existing wallet when either tenant or owner scope is mismatched", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Wallet scope isolation fixture" } });
    const otherTenant = await prisma.tenant.create({ data: { name: "Other wallet scope fixture" } });
    const wallet = await prisma.walletAccount.create({
      data: {
        tenantId: tenant.id,
        ownerId: `scope-owner-${process.pid}-${Date.now()}`,
        currency: "EUR",
        balanceCents: 9_000n,
        reservedCents: 0n,
      },
    });

    await expect(reconcileWalletJournal(prisma, {
      tenantId: otherTenant.id,
      ownerId: wallet.ownerId,
      accountId: wallet.id,
    })).rejects.toThrow("WALLET_NOT_FOUND");

    await expect(reconcileWalletJournal(prisma, {
      tenantId: tenant.id,
      ownerId: "different-owner",
      accountId: wallet.id,
    })).rejects.toThrow("WALLET_NOT_FOUND");

    const correctlyScoped = await reconcileWalletJournal(prisma, {
      tenantId: tenant.id,
      ownerId: wallet.ownerId,
      accountId: wallet.id,
    });
    expect(correctlyScoped.accountId).toBe(wallet.id);
    expect(correctlyScoped.tenantId).toBe(tenant.id);
  });
});

if (!databaseEnabled) void prisma.$disconnect();
