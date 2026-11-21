import { Prisma, PrismaClient } from "@prisma/client";
import { enqueueOutboxEvent } from "./outbox-service.js";
import { runSerializableTransaction } from "./transaction-retry.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type ReserveFundsInput = {
  accountId: string;
  ownerId: string;
  tenantId: string;
  amountCents: bigint;
  referenceId: string;
  correlationId?: string;
  description: string;
};

export type WalletSnapshot = {
  accountId: string;
  balanceCents: bigint;
  reservedCents: bigint;
  availableCents: bigint;
  currency: string;
};

function assertPositiveAmount(amount: bigint): void {
  if (amount <= 0n) throw new Error("AMOUNT_MUST_BE_POSITIVE");
}

async function snapshot(db: Db, input: Pick<ReserveFundsInput, "accountId" | "ownerId" | "tenantId">): Promise<WalletSnapshot> {
  const account = await db.walletAccount.findFirst({ where: { id: input.accountId, ownerId: input.ownerId, tenantId: input.tenantId } });
  if (!account) throw new Error("WALLET_NOT_FOUND");
  return {
    accountId: account.id,
    balanceCents: account.balanceCents,
    reservedCents: account.reservedCents,
    availableCents: account.balanceCents - account.reservedCents,
    currency: account.currency,
  };
}

/**
 * Reserves available funds atomically. Call only from an authenticated,
 * server-authorized workflow. The caller must use a stable referenceId for retries.
 */
export async function reserveFundsInTransaction(
  tx: Prisma.TransactionClient,
  input: ReserveFundsInput,
): Promise<WalletSnapshot> {
  assertPositiveAmount(input.amountCents);
  if (!input.referenceId.trim()) throw new Error("REFERENCE_ID_REQUIRED");
  if (!input.ownerId.trim() || !input.tenantId.trim()) throw new Error("WALLET_OWNER_REQUIRED");

  return (async () => {
    // Lock the account row so concurrent reservations cannot spend the same balance.
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "WalletAccount" WHERE id = ${input.accountId} AND "ownerId" = ${input.ownerId} AND "tenantId" = ${input.tenantId} FOR UPDATE
    `;
    if (rows.length === 0) throw new Error("WALLET_NOT_FOUND");

    const existing = await tx.walletLedger.findUnique({
      where: { accountId_referenceId: { accountId: input.accountId, referenceId: input.referenceId } },
    });
    if (existing) {
      if (existing.accountId !== input.accountId ||
          existing.entryType !== "RESERVATION" ||
          existing.amountCents !== input.amountCents) {
        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      return snapshot(tx, input);
    }

    const account = await tx.walletAccount.findFirst({ where: { id: input.accountId, ownerId: input.ownerId, tenantId: input.tenantId } });
    if (!account) throw new Error("WALLET_NOT_FOUND");
    const available = account.balanceCents - account.reservedCents;
    if (available < input.amountCents) throw new Error("INSUFFICIENT_AVAILABLE_FUNDS");

    await tx.walletAccount.update({
      where: { id: account.id },
      data: { reservedCents: { increment: input.amountCents }, version: { increment: 1 } },
    });
    const ledgerEntry = await tx.walletLedger.create({
      data: {
        accountId: account.id,
        entryType: "RESERVATION",
        amountCents: input.amountCents,
        referenceId: input.referenceId,
        correlationId: input.correlationId,
        description: input.description,
      },
    });
    await enqueueOutboxEvent(tx, {
      eventType: "wallet.reservation.created",
      aggregateId: account.id,
      correlationId: input.correlationId ?? input.referenceId,
      schemaVersion: 1,
      payload: {
        tenantId: input.tenantId,
        accountId: account.id,
        ledgerEntryId: ledgerEntry.id,
        referenceId: input.referenceId,
        amountCents: input.amountCents.toString(),
        currency: account.currency,
        eventType: "RESERVATION",
      },
    });
    return snapshot(tx, input);
  })();
}

export async function reserveFunds(
  prisma: PrismaClient,
  input: ReserveFundsInput,
): Promise<WalletSnapshot> {
  return runSerializableTransaction(prisma, (tx) => reserveFundsInTransaction(tx, input));
}

export type ReleaseFundsInput = {
  accountId: string;
  ownerId: string;
  tenantId: string;
  amountCents: bigint;
  referenceId: string;
  reservationReferenceId: string;
  correlationId?: string;
  description: string;
}

/** Releases part or all of a prior reservation; cumulative releases may never exceed the source amount. */
export async function releaseFundsInTransaction(
  tx: Prisma.TransactionClient,
  input: ReleaseFundsInput,
): Promise<WalletSnapshot> {
  assertPositiveAmount(input.amountCents);
  if (!input.referenceId.trim()) throw new Error("REFERENCE_ID_REQUIRED");
  if (!input.reservationReferenceId.trim()) throw new Error("RESERVATION_REFERENCE_REQUIRED");
  if (!input.ownerId.trim() || !input.tenantId.trim()) throw new Error("WALLET_OWNER_REQUIRED");

  return (async () => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "WalletAccount" WHERE id = ${input.accountId} AND "ownerId" = ${input.ownerId} AND "tenantId" = ${input.tenantId} FOR UPDATE
    `;
    if (rows.length === 0) throw new Error("WALLET_NOT_FOUND");

    const existing = await tx.walletLedger.findUnique({ where: { referenceId: input.referenceId } });
    if (existing) {
      if (existing.accountId !== input.accountId ||
          existing.entryType !== "RESERVATION_RELEASE" ||
          existing.amountCents !== input.amountCents ||
          existing.reservationReferenceId !== input.reservationReferenceId) {
        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      return snapshot(tx, input);
    }

    const originalReservation = await tx.walletLedger.findUnique({
      where: { accountId_referenceId: { accountId: input.accountId, referenceId: input.reservationReferenceId } },
    });
    if (!originalReservation || originalReservation.accountId !== input.accountId ||
        originalReservation.entryType !== "RESERVATION") {
      throw new Error("ORIGINAL_RESERVATION_NOT_FOUND_OR_MISMATCHED");
    }
    const priorReleases = await tx.walletLedger.aggregate({
      where: {
        accountId: input.accountId,
        entryType: "RESERVATION_RELEASE",
        reservationReferenceId: input.reservationReferenceId,
      },
      _sum: { amountCents: true },
    });
    const alreadyReleasedCents = priorReleases._sum.amountCents ?? 0n;
    if (alreadyReleasedCents + input.amountCents > originalReservation.amountCents) {
      throw new Error("RESERVATION_RELEASE_EXCEEDS_ORIGINAL_AMOUNT");
    }
    const account = await tx.walletAccount.findFirst({ where: { id: input.accountId, ownerId: input.ownerId, tenantId: input.tenantId } });
    if (!account) throw new Error("WALLET_NOT_FOUND");
    if (account.reservedCents < input.amountCents) throw new Error("RESERVATION_BALANCE_TOO_LOW");

    await tx.walletAccount.update({
      where: { id: account.id },
      data: { reservedCents: { decrement: input.amountCents }, version: { increment: 1 } },
    });
    const ledgerEntry = await tx.walletLedger.create({
      data: {
        accountId: account.id,
        entryType: "RESERVATION_RELEASE",
        amountCents: input.amountCents,
        referenceId: input.referenceId,
        reservationReferenceId: input.reservationReferenceId,
        correlationId: input.correlationId,
        description: input.description,
      },
    });
    await enqueueOutboxEvent(tx, {
      eventType: "wallet.reservation.released",
      aggregateId: account.id,
      correlationId: input.correlationId ?? input.referenceId,
      schemaVersion: 1,
      payload: {
        tenantId: input.tenantId,
        accountId: account.id,
        ledgerEntryId: ledgerEntry.id,
        referenceId: input.referenceId,
        reservationReferenceId: input.reservationReferenceId,
        amountCents: input.amountCents.toString(),
        currency: account.currency,
        eventType: "RESERVATION_RELEASE",
      },
    });
    return snapshot(tx, input);
  })();
}

export async function releaseFunds(
  prisma: PrismaClient,
  input: ReleaseFundsInput,
): Promise<WalletSnapshot> {
  return runSerializableTransaction(prisma, (tx) => releaseFundsInTransaction(tx, input));
}
