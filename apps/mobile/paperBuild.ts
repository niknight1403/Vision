/**
 * Stable marker for the PAPER-only release artifacts.
 *
 * The Android preview pipeline greps the compiled JavaScript bundle for this
 * ASCII-only token before an APK is handed out, so a build that accidentally
 * ships without the PAPER guardrails cannot be mistaken for a verified one.
 * Keep the token in one place and never change it without updating
 * .github/workflows/android-preview-apk.yml and
 * scripts/verify-paper-lockdown.mjs.
 */
export const PAPER_BUILD_MARKER = "AUTONOMAGENT_PAPER_ONLY_BUILD";

/** Trading posture this bundle was compiled with. */
export const PAPER_BUILD_GUARDRAILS = {
  tradingMode: "PAPER",
  liveTradingEnabled: false,
} as const;
