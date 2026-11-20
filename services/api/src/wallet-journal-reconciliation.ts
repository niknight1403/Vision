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
  code: "POLICY_NOT_CONFIGURED" | "INVALID_WALLET_EVIDENCE" | "INVALID_POLICY" |
    "JOURNAL_NOT_FOUND" | "AMBIGUOUS_JOURNAL_REFERENCE" | "JOURNAL_NOT_POSTED" |
    "CURRENCY_MISMATCH" | "JOURNAL_UNBALANCED" | "JOURNAL_LINES_INVALID" |
    "JOURNAL_LINES_MISMATCH";
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

function validLines(lines: WalletJournalLine[]) {
  return lines.length >= 2 && lines.every((line) =>
    line.accountCode.trim().length > 0 &&
    line.debitCents >= 0n &&
    line.creditCents >= 0n &&
    !(line.debitCents > 0n && line.creditCents > 0n) &&
    (line.debitCents > 0n || line.creditCents > 0n));
}

function balanced(lines: WalletJournalLine[]) {
  const debit = lines.reduce((sum, line) => sum + line.debitCents, 0n);
  const credit = lines.reduce((sum, line) => sum + line.creditCents, 0n);
  return debit > 0n && debit === credit;
}

/**
 * Read-only evidence comparison. Accounting semantics and reference conventions
 * are supplied by the caller; none are inferred from wallet event types.
 */
export function reconcileWalletJournalEvidence(
  walletEntries: WalletJournalEvidence[],
  journals: JournalEvidence[],
  policies: Record<string, WalletJournalPolicy>,
) {
  const journalsByScopeAndReference = new Map<string, JournalEvidence[]>();
  for (const journal of journals) {
    const key = `${journal.tenantId}\u0000${journal.referenceId}`;
    const matches = journalsByScopeAndReference.get(key) ?? [];
    matches.push(journal);
    journalsByScopeAndReference.set(key, matches);
  }

  const findings: WalletJournalFinding[] = [];
  for (const wallet of walletEntries) {
    const base = {
      walletLedgerId: wallet.walletLedgerId,
      walletReferenceId: wallet.walletReferenceId,
    };
    if (!wallet.walletLedgerId.trim() || !wallet.tenantId.trim() ||
        !wallet.walletReferenceId.trim() || !wallet.entryType.trim() ||
        !wallet.currency.trim() || wallet.amountCents <= 0n) {
      findings.push({ code: "INVALID_WALLET_EVIDENCE", severity: "CRITICAL", ...base });
      continue;
    }

    if (!Object.hasOwn(policies, wallet.walletLedgerId)) {
      findings.push({ code: "POLICY_NOT_CONFIGURED", severity: "WARNING", ...base });
      continue;
    }
    const policy = policies[wallet.walletLedgerId];
    const policyBase = { ...base, journalReferenceId: policy.journalReferenceId };
    if (!policy.journalReferenceId.trim() || !validLines(policy.expectedLines) ||
        !balanced(policy.expectedLines)) {
      findings.push({ code: "INVALID_POLICY", severity: "CRITICAL", ...policyBase });
      continue;
    }

    const matches = journalsByScopeAndReference.get(
      `${wallet.tenantId}\u0000${policy.journalReferenceId}`,
    ) ?? [];
    if (matches.length === 0) {
      findings.push({ code: "JOURNAL_NOT_FOUND", severity: "CRITICAL", ...policyBase });
      continue;
    }
    if (matches.length > 1) {
      findings.push({ code: "AMBIGUOUS_JOURNAL_REFERENCE", severity: "CRITICAL", ...policyBase });
      continue;
    }

    const journal = matches[0];
    if (!journal.postedAt) findings.push({ code: "JOURNAL_NOT_POSTED", severity: "CRITICAL", ...policyBase });
    if (journal.currency.toUpperCase() !== wallet.currency.toUpperCase()) {
      findings.push({ code: "CURRENCY_MISMATCH", severity: "CRITICAL", ...policyBase });
    }
    if (!validLines(journal.entries)) {
      findings.push({ code: "JOURNAL_LINES_INVALID", severity: "CRITICAL", ...policyBase });
    }
    if (!balanced(journal.entries)) {
      findings.push({ code: "JOURNAL_UNBALANCED", severity: "CRITICAL", ...policyBase });
    }
    if (JSON.stringify(canonicalLines(journal.entries)) !==
        JSON.stringify(canonicalLines(policy.expectedLines))) {
      findings.push({ code: "JOURNAL_LINES_MISMATCH", severity: "CRITICAL", ...policyBase });
    }
  }

  return {
    checkedWalletEntries: walletEntries.length,
    checkedJournals: journals.length,
    findings,
    consistent: findings.length === 0,
  };
}
