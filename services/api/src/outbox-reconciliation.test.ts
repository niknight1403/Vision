import { describe, expect, it } from "vitest";
import { reconcileOutboxEvents, type ReconciliationEvent } from "./outbox-reconciliation.js";

const now = new Date("2026-11-20T12:00:00.000Z");
function event(overrides: Partial<ReconciliationEvent> = {}): ReconciliationEvent {
  return {
    id: "event-1", eventType: "wallet.reservation.created", status: "PUBLISHED",
    attempts: 1, availableAt: new Date("2026-11-20T11:00:00.000Z"),
    leaseUntil: null, lockedBy: null, publishedAt: new Date("2026-11-20T11:01:00.000Z"),
    createdAt: new Date("2026-11-20T11:00:00.000Z"), consumerReceipts: [],
    ...overrides,
  };
}

describe("read-only outbox reconciliation", () => {
  it("reports missing required consumer receipts without requiring unrelated consumers", () => {
    const report = reconcileOutboxEvents(
      [event({ consumerReceipts: [{ consumerName: "audit", processedAt: now }] })],
      { "wallet.reservation.created": ["audit", "ledger-projection"] },
      { now },
    );
    expect(report.scanned).toBe(1);
    expect(report.counts.PUBLISHED).toBe(1);
    expect(report.findings).toEqual([{
      code: "REQUIRED_RECEIPT_MISSING", severity: "CRITICAL",
      eventId: "event-1", eventType: "wallet.reservation.created",
      consumerName: "ledger-projection",
    }]);
  });

  it("detects incomplete and expired processing leases and unexpected locks", () => {
    const report = reconcileOutboxEvents([
      event({ id: "incomplete", status: "PROCESSING", lockedBy: null, leaseUntil: null, publishedAt: null }),
      event({ id: "expired", status: "PROCESSING", lockedBy: "worker-a", leaseUntil: new Date("2026-11-20T11:59:00.000Z"), publishedAt: null }),
      event({ id: "unexpected", status: "PENDING", lockedBy: "worker-b", leaseUntil: null, publishedAt: null }),
    ], {}, { now });
    expect(report.findings.map((finding) => [finding.eventId, finding.code])).toEqual([
      ["incomplete", "PROCESSING_LEASE_INCOMPLETE"],
      ["expired", "EXPIRED_LEASE"],
      ["unexpected", "UNEXPECTED_LOCK"],
    ]);
  });

  it("flags missing published timestamps, dead letters and overdue pending events", () => {
    const report = reconcileOutboxEvents([
      event({ id: "no-published-at", publishedAt: null }),
      event({ id: "dead", status: "DEAD_LETTER", publishedAt: null }),
      event({ id: "old-pending", status: "PENDING", publishedAt: null, availableAt: new Date("2026-11-20T11:00:00.000Z") }),
    ], {}, { now, pendingWarningSeconds: 60 });
    expect(report.findings.map((finding) => [finding.eventId, finding.code])).toEqual([
      ["no-published-at", "PUBLISHED_TIMESTAMP_MISSING"],
      ["dead", "DEAD_LETTER"],
      ["old-pending", "PENDING_OVERDUE"],
    ]);
  });

  it("rejects invalid thresholds", () => {
    expect(() => reconcileOutboxEvents([], {}, { pendingWarningSeconds: -1 }))
      .toThrow("INVALID_PENDING_WARNING_SECONDS");
  });
});
