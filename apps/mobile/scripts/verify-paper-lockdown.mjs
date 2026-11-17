#!/usr/bin/env node
/**
 * PAPER lockdown guard for the AutonomAgent mobile app.
 *
 * The Android preview build must never be able to place a live or testnet
 * order. This script fails the build when the resolved Expo config, the
 * trading core or the app sources allow anything but PAPER, and when a secret
 * would leak into an EXPO_PUBLIC_* variable.
 *
 * Usage: node scripts/verify-paper-lockdown.mjs [--quiet]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(here, "..");
const repoRoot = resolve(mobileRoot, "..", "..");
const quiet = process.argv.includes("--quiet");

const failures = [];
const evidence = [];

function fail(message) {
  failures.push(message);
}

function record(label, value) {
  evidence.push([label, String(value)]);
}

/** Reads the config exactly as Expo would resolve it for a build. */
function resolveExpoConfig() {
  const raw = execFileSync("npx", ["expo", "config", "--type", "public", "--json"], {
    cwd: mobileRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const start = raw.indexOf("{");
  if (start < 0) throw new Error(`expo config did not return JSON: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start));
}

const config = resolveExpoConfig();
const extra = config.extra ?? {};

if (extra.tradingMode !== "PAPER") fail(`extra.tradingMode must be "PAPER" but is ${JSON.stringify(extra.tradingMode)}`);
if (extra.liveTradingEnabled !== false) fail(`extra.liveTradingEnabled must be false but is ${JSON.stringify(extra.liveTradingEnabled)}`);
record("expo.extra.tradingMode", extra.tradingMode);
record("expo.extra.liveTradingEnabled", extra.liveTradingEnabled);

const autopilotSource = readFileSync(join(repoRoot, "packages", "trading-core", "src", "autopilot.ts"), "utf8");
if (!/^\s*mode: "PAPER";$/m.test(autopilotSource)) fail("trading-core autopilot must declare mode: \"PAPER\"");
if (!/^\s*liveTradingEnabled: false;$/m.test(autopilotSource)) fail("trading-core autopilot must declare liveTradingEnabled: false");
record("trading-core autopilot mode", /^\s*mode: "PAPER";$/m.test(autopilotSource) ? "PAPER" : "unexpected");

// Anything that would turn live trading on, or that would bake a credential
// into the public bundle, is a hard failure.
const forbidden = [
  [/liveTradingEnabled\s*[:=]\s*true/, "enables live trading"],
  [/tradingMode\s*[:=]\s*"(LIVE|TESTNET)"/, "selects a live or testnet mode"],
  [/\bmode\s*:\s*"(LIVE|TESTNET)"/, "selects a live or testnet mode"],
  [/EXPO_PUBLIC_[A-Z0-9_]*(SECRET|TOKEN|PRIVATE|PASSWORD|KEY)\b/, "exposes a secret through EXPO_PUBLIC_*"],
];

function walk(directory, visit) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "android" || entry === "ios" || entry === ".expo") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, visit);
    else visit(path);
  }
}

const scannedRoots = [mobileRoot, join(repoRoot, "packages", "trading-core", "src")];
let scannedFiles = 0;
for (const root of scannedRoots) {
  walk(root, (path) => {
    if (!/\.(ts|tsx|js|mjs|cjs|json)$/.test(path)) return;
    if (path.endsWith("package-lock.json")) return;
    scannedFiles += 1;
    const text = readFileSync(path, "utf8");
    for (const [pattern, reason] of forbidden) {
      const match = text.match(pattern);
      if (match) fail(`${relative(repoRoot, path)} ${reason}: ${match[0].trim()}`);
    }
  });
}
record("source files scanned", scannedFiles);

for (const trackedEnv of ["apps/mobile/.env", ".env", "apps/mobile/.env.local"]) {
  if (existsSync(join(repoRoot, trackedEnv))) fail(`${trackedEnv} must not exist in a release build context`);
}
record("EXPO_PUBLIC_API_URL baked", process.env.EXPO_PUBLIC_API_URL ? process.env.EXPO_PUBLIC_API_URL : "(none)");

if (failures.length > 0) {
  console.error("PAPER lockdown FAILED:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

if (!quiet) {
  console.log("PAPER lockdown OK");
  for (const [label, value] of evidence) console.log(`  ${label}: ${value}`);
}
