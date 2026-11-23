import { describe, expect, it } from "vitest";
import { walletJournalAccountCodes } from "./wallet-journal-reconciliation.js";

describe("wallet journal account-code convention", () => {
  it("derives tenant-independent subaccount codes from a non-empty wallet ID", () => {
    expect(walletJournalAccountCodes("wallet-123")).toEqual({
      available: "WALLET:wallet-123:AVAILABLE",
      reserved: "WALLET:wallet-123:RESERVED",
    });
  });

  it("rejects an empty wallet ID", () => {
    expect(() => walletJournalAccountCodes("")).toThrow("WALLET_ACCOUNT_REQUIRED");
  });
});
