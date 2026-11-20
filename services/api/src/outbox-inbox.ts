import { Prisma } from "@prisma/client";
import type { OutboxMessage } from "./outbox-worker.js";

export type TransactionalOutboxConsumer = (
  tx: Prisma.TransactionClient,
  message: OutboxMessage,
) => Promise<void>;

/**
 * Claims an event for a named consumer and runs its database effects in the
 * same caller-owned transaction. A receipt is committed only with the effects;
 * a failed handler rolls both back. This protects database effects, not remote
 * side effects which cannot participate in the PostgreSQL transaction.
 */
export async function processOutboxEventInTransaction(
  tx: Prisma.TransactionClient,
  consumerName: string,
  message: OutboxMessage,
  handler: TransactionalOutboxConsumer,
): Promise<"PROCESSED" | "DUPLICATE"> {
  const normalizedConsumer = consumerName.trim();
  if (!normalizedConsumer || normalizedConsumer.length > 128) {
    throw new Error("OUTBOX_CONSUMER_NAME_INVALID");
  }
  if (!message.id.trim()) throw new Error("OUTBOX_EVENT_ID_REQUIRED");

  try {
    await tx.outboxConsumerReceipt.create({
      data: { consumerName: normalizedConsumer, eventId: message.id },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return "DUPLICATE";
    }
    throw error;
  }

  await handler(tx, message);
  return "PROCESSED";
}
