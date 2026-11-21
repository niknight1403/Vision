import { Prisma } from "@prisma/client";

/**
 * Persists an outbox event in the caller's transaction.
 *
 * The caller must include this write in the same transaction as the state
 * mutation it announces. Dispatch remains at-least-once; consumers must
 * deduplicate by the event's stable business identity carried in payload.
 */
export type EnqueueOutboxEventInput = {
  eventType: string;
  aggregateId: string;
  correlationId?: string;
  schemaVersion?: number;
  payload: Prisma.InputJsonValue;
  availableAt?: Date;
};

export async function enqueueOutboxEvent(
  tx: Prisma.TransactionClient,
  input: EnqueueOutboxEventInput,
) {
  if (!input.eventType.trim() || !input.aggregateId.trim()) {
    throw new Error("OUTBOX_REQUIRED_FIELDS_MISSING");
  }
  if (!Number.isInteger(input.schemaVersion ?? 1) || (input.schemaVersion ?? 1) < 1) {
    throw new Error("OUTBOX_SCHEMA_VERSION_INVALID");
  }
  return tx.outboxEvent.create({
    data: {
      eventType: input.eventType.trim(),
      aggregateId: input.aggregateId.trim(),
      correlationId: input.correlationId,
      schemaVersion: input.schemaVersion ?? 1,
      payload: input.payload,
      availableAt: input.availableAt,
    },
  });
}
