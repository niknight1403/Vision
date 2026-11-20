export type WalletJournalLine = {
  accountCode: string;
  debitCents: bigint;
  creditCents: bigint;
};

export type WalletJournalEvidence = {
  walletLedgerId: string;
  tenantId: string;
  entryType: string;
  walletReferenceId: string;
  amountCents: bigint;
  currency: string;
};

export type JournalEvidence = {
  id: string;
  tenantId: string;
  referenceId: string;
  currency: string;
  postedAt: Date | null;
  entries: WalletJournalLine[];
};

export type WalletJournalPolicy = {
  /** Exact journal reference; caller supplies the approved convention. */
  journalReferenceId: string;
  /** Exact expected lines from an approved accounting policy. */
  expectedLines: WalletJournalLine[];
};

export type WalletJournalFinding = {
  code: "POLICY_NOT_CONFIGURED" | "JOURNAL_NOT_FOUND" | "JOURNAL_NOT_POSTED" |
    "CURRENCY_MISMATCH" | "JOURNAL_UNBALANCED" | "JOURNAL_LINES_MISMATCH";
  severity: "WARNING" | "CRITICAL";
  walletLedgerId: string;
  walletReferenceId: string;
  journalReferenceId?: string;
};

function canonicalLines(lines: WalletJournalLine[]) {
  return lines.map((line) => ({
    accountCode: line.accountCode,
    debitCents: line.debitCents.toString(),
    creditCents: line.creditCents.toString(),
  })).sort((a, b) =>
    a.accountCode.localeCompare(b.accountCode) ||
    a.debitCents.localeCompare(b.debitCents) ||
    a.creditCents.localeCompare(b.creditCents));
}

/**
 * Compares wallet and journal evidence only when the caller supplies an
 * explicit policy for that wallet ledger row. No accounting treatment,
 * reference convention, or account code is inferred here.
 */
export function reconcileWalletJournalEvidence(
  walletEntries: WalletJournalEvidence[],
  journals: JournalEvidence[],
  policies: Record<string, WalletJournalPolicy>,
) {
  const journalByScopeAndReference = new Map(
    journals.map((journal) => [`${journal.tenantId}\u0000${journal.referenceId}`, journal]),
  );
  const findings: WalletJournalFinding[] = [];

  for (const wallet of walletEntries) {
    const policy = policies[wallet.walletLedgerId];
    if (!policy) {
      findings.push({
        code: "POLICY_NOT_CONFIGURED", severity: "WARNING",
        walletLedgerId: wallet.walletLedgerId, walletReferenceId: wallet.walletReferenceId,
      });
      continue;
    }

    const journal = journalByScopeAndReference.get(
      `${wallet.tenantId}\u0000${policy.journalReferenceId}`,
    );
    const base = {
      walletLedgerId: wallet.walletLedgerId,
      walletReferenceId: wallet.walletReferenceId,
      journalReferenceId: policy.journalReferenceId,
    };
    if (!journal) {
      findings.push({ code: "JOURNAL_NOT_FOUND", severity: "CRITICAL", ...base });
      continue;
    }
    if (!journal.postedAt) findings.push({ code: "JOURNAL_NOT_POSTED", severity: "CRITICAL", ...base });
    if (journal.currency.toUpperCase() !== wallet.currency.toUpperCase()) {
      findings.push({ code: "CURRENCY_MISMATCH", severity: "CRITICAL", ...base });
    }
    const debit = journal.entries.reduce((sum, line) => sum + line.debitCents, 0n);
    const credit = journal.entries.reduce((sum, line) => sum + line.creditCents, 0n);
    if (journal.entries.length < 2 || debit <= 0n || debit !== credit) {
      findings.push({ code: "JOURNAL_UNBALANCED", severity: "CRITICAL", ...base });
    }
    if (JSON.stringify(canonicalLines(journal.entries)) !==
        JSON.stringify(canonicalLines(policy.expectedLines))) {
      findings.push({ code: "JOURNAL_LINES_MISMATCH", severity: "CRITICAL", ...base });
    }
  }

  return {
    checkedWalletEntries: walletEntries.length,
    checkedJournals: journals.length,
    findings,
    consistent: findings.length === 0,
  };
}
