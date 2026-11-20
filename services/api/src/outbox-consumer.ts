import type { OutboxMessage, OutboxHandler } from "./outbox-worker.js";

/**
 * Exact-version dispatch for outbox consumers. There is deliberately no
 * fallback to a different schema version: unknown contracts fail closed
 * before consumer code can produce a side effect.
 */
export class OutboxConsumerRegistry {
  private readonly handlers = new Map<string, Map<number, OutboxHandler>>();

  register(eventType: string, schemaVersion: number, handler: OutboxHandler): this {
    const normalizedType = eventType.trim();
    if (!normalizedType) throw new Error("OUTBOX_CONSUMER_EVENT_TYPE_REQUIRED");
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
      throw new Error("OUTBOX_CONSUMER_SCHEMA_VERSION_INVALID");
    }
    const versions = this.handlers.get(normalizedType) ?? new Map<number, OutboxHandler>();
    if (versions.has(schemaVersion)) {
      throw new Error("OUTBOX_CONSUMER_VERSION_ALREADY_REGISTERED");
    }
    versions.set(schemaVersion, handler);
    this.handlers.set(normalizedType, versions);
    return this;
  }

  async dispatch(message: OutboxMessage): Promise<void> {
    if (!Number.isSafeInteger(message.schemaVersion) || message.schemaVersion < 1) {
      throw new Error("OUTBOX_SCHEMA_VERSION_INVALID");
    }
    const handler = this.handlers.get(message.eventType)?.get(message.schemaVersion);
    if (!handler) {
      throw new Error(
        `OUTBOX_UNSUPPORTED_SCHEMA_VERSION:${message.eventType}:v${message.schemaVersion}`,
      );
    }
    await handler(message);
  }
}
