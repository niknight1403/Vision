import { describe, expect, it } from "vitest";
import { reconcileWalletJournalEvidence, type JournalEvidence, type WalletJournalEvidence } from "./wallet-journal-reconciliation.js";

const wallet: WalletJournalEvidence = {
  walletLedgerId: "wallet-ledger-1", tenantId: "tenant-a", entryType: "RESERVATION",
  walletReferenceId: "wallet-ref-1", amountCents: 2_500n, currency: "EUR",
};
const journal: JournalEvidence = {
  id: "journal-1", tenantId: "tenant-a", referenceId: "journal-ref-1",
  currency: "EUR", postedAt: new Date("2026-11-20T12:00:00Z"),
  entries: [
    { accountCode: "APPROVED-DEBIT", debitCents: 2_500n, creditCents: 0n },
    { accountCode: "APPROVED-CREDIT", debitCents: 0n, creditCents: 2_500n },
  ],
};
const policy = {
  "wallet-ledger-1": {
    journalReferenceId: "journal-ref-1",
    expectedLines: [
      { accountCode: "APPROVED-CREDIT", debitCents: 0n, creditCents: 2_500n },
      { accountCode: "APPROVED-DEBIT", debitCents: 2_500n, creditCents: 0n },
    ],
  },
};

describe("policy-driven wallet/journal evidence reconciliation", () => {
  it("reports unconfigured wallet accounting policy without inventing a journal", () => {
    const result = reconcileWalletJournalEvidence([wallet], [journal], {});
    expect(result.consistent).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["POLICY_NOT_CONFIGURED"]);
  });

  it("matches only exact tenant-scoped reference, currency and approved lines", () => {
    const result = reconcileWalletJournalEvidence([wallet], [journal], policy);
    expect(result.consistent).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("does not match a journal from another tenant", () => {
    const result = reconcileWalletJournalEvidence([wallet], [{ ...journal, tenantId: "tenant-b" }], policy);
    expect(result.findings.map((finding) => finding.code)).toEqual(["JOURNAL_NOT_FOUND"]);
  });

  it("reports unposted, currency, balance and approved-line discrepancies", () => {
    const result = reconcileWalletJournalEvidence([wallet], [{
      ...journal, currency: "USD", postedAt: null,
      entries: [{ accountCode: "WRONG", debitCents: 2_000n, creditCents: 0n }],
    }], policy);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "JOURNAL_NOT_POSTED", "CURRENCY_MISMATCH", "JOURNAL_UNBALANCED", "JOURNAL_LINES_MISMATCH",
    ]);
  });

  it("rejects duplicate tenant-scoped journal references as ambiguous", () => {
    const result = reconcileWalletJournalEvidence([wallet], [journal, { ...journal, id: "journal-duplicate" }], policy);
    expect(result.findings.map((finding) => finding.code)).toEqual(["AMBIGUOUS_JOURNAL_REFERENCE"]);
  });

  it("rejects malformed wallet evidence and invalid policy lines", () => {
    const invalidWallet = reconcileWalletJournalEvidence([{ ...wallet, amountCents: 0n }], [journal], policy);
    expect(invalidWallet.findings.map((finding) => finding.code)).toEqual(["INVALID_WALLET_EVIDENCE"]);

    const invalidPolicy = {
      "wallet-ledger-1": {
        journalReferenceId: "journal-ref-1",
        expectedLines: [{ accountCode: "BAD", debitCents: -1n, creditCents: 0n }],
      },
    };
    const invalidMapping = reconcileWalletJournalEvidence([wallet], [journal], invalidPolicy);
    expect(invalidMapping.findings.map((finding) => finding.code)).toEqual(["INVALID_POLICY"]);
  });

  it("rejects journal lines with negative, empty, or dual-sided amounts", () => {
    const result = reconcileWalletJournalEvidence([wallet], [{
      ...journal,
      entries: [
        { accountCode: "BAD", debitCents: 1n, creditCents: 1n },
        { accountCode: "", debitCents: -1n, creditCents: 0n },
      ],
    }], policy);
    expect(result.findings.map((finding) => finding.code)).toContain("JOURNAL_LINES_INVALID");
    expect(result.findings.map((finding) => finding.code)).toContain("JOURNAL_UNBALANCED");
  });
});
