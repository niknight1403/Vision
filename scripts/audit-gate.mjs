#!/usr/bin/env node
/**
 * Dependency advisory gate for CI.
 *
 * Fails on every high or critical advisory except the ones listed in
 * `.github/security/audit-exceptions.json`. An exception is only valid while it
 * is unexpired AND the advisory still has no patched version published, so a
 * fixed release turns the exception into a failure that has to be cleaned up
 * with a real upgrade.
 *
 * Usage: node scripts/audit-gate.mjs [--report <npm-audit-json>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exceptionsPath = resolve(repoRoot, ".github/security/audit-exceptions.json");
const blockingSeverities = new Set(["high", "critical"]);
const today = new Date().toISOString().slice(0, 10);

const problems = [];
const notes = [];

const readAudit = () => {
  const reportFlag = process.argv.indexOf("--report");
  if (reportFlag !== -1 && process.argv[reportFlag + 1]) {
    return JSON.parse(readFileSync(resolve(process.cwd(), process.argv[reportFlag + 1]), "utf8"));
  }
  const audit = spawnSync("npm", ["audit", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!audit.stdout) {
    problems.push(`npm audit produced no output (exit ${audit.status}): ${audit.stderr?.slice(0, 400)}`);
    return null;
  }
  try {
    return JSON.parse(audit.stdout);
  } catch (error) {
    problems.push(`could not parse npm audit JSON: ${error.message}`);
    return null;
  }
};

/** Collect the root advisories (npm reports transitive packages as plain names). */
const collectAdvisories = (audit) => {
  const advisories = new Map();
  for (const [packageName, entry] of Object.entries(audit.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== "object" || !via) continue;
      const id = via.url?.split("/").pop();
      if (!id) continue;
      const existing = advisories.get(id) ?? {
        id,
        title: via.title ?? "(no title)",
        severity: via.severity ?? entry.severity,
        packages: new Set(),
      };
      existing.packages.add(packageName);
      advisories.set(id, existing);
    }
  }
  return advisories;
};

const loadExceptions = () => {
  if (!existsSync(exceptionsPath)) return new Map();
  const parsed = JSON.parse(readFileSync(exceptionsPath, "utf8"));
  const byId = new Map();
  for (const exception of parsed.exceptions ?? []) {
    for (const field of ["id", "package", "reason", "tracking", "expires_on"]) {
      if (!exception[field]) problems.push(`exception ${exception.id ?? "(no id)"} is missing "${field}"`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expires_on ?? "")) {
      problems.push(`exception ${exception.id} has an invalid expires_on date`);
    }
    byId.set(exception.id, exception);
  }
  return byId;
};

/** Ask GitHub whether upstream already published a fix for this advisory. */
const fetchPatchedVersions = async (ghsaId) => {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "autonomagent-audit-gate" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/advisories/${ghsaId}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const advisory = await response.json();
  return (advisory.vulnerabilities ?? []).map((vulnerability) => ({
    package: vulnerability.package?.name,
    firstPatchedVersion: vulnerability.first_patched_version ?? null,
  }));
};

const main = async () => {
  const audit = readAudit();
  if (!audit) {
    console.error("Dependency advisory gate failed:");
    for (const problem of problems) console.error(` - ${problem}`);
    process.exit(1);
  }

  const advisories = collectAdvisories(audit);
  const exceptions = loadExceptions();
  const counts = audit.metadata?.vulnerabilities ?? {};

  for (const [id, exception] of exceptions) {
    if (exception.expires_on < today) {
      problems.push(`exception for ${id} (${exception.package}) expired on ${exception.expires_on}`);
    }
    if (!advisories.has(id)) {
      problems.push(`exception for ${id} (${exception.package}) is stale: npm audit no longer reports it`);
    }
  }

  for (const advisory of advisories.values()) {
    if (!blockingSeverities.has(advisory.severity)) {
      notes.push(`${advisory.severity} advisory ignored by this gate: ${advisory.id} (${[...advisory.packages].join(", ")})`);
      continue;
    }
    const exception = exceptions.get(advisory.id);
    if (!exception) {
      problems.push(
        `${advisory.severity} advisory ${advisory.id} (${[...advisory.packages].join(", ")}) is not covered: ${advisory.title}`,
      );
      continue;
    }
    try {
      const affected = await fetchPatchedVersions(advisory.id);
      for (const entry of affected) {
        if (entry.firstPatchedVersion && advisory.packages.has(entry.package)) {
          problems.push(
            `advisory ${advisory.id} now has a patched release (${entry.package} ${entry.firstPatchedVersion}); ` +
              `drop the exception and upgrade instead`,
          );
        }
      }
    } catch (error) {
      notes.push(`could not confirm patched releases for ${advisory.id} (${error.message}); relying on the expiry date`);
    }
  }

  if (problems.length > 0) {
    console.error("Dependency advisory gate failed:");
    for (const problem of problems) console.error(` - ${problem}`);
    if (notes.length > 0) for (const note of notes) console.error(`   note: ${note}`);
    process.exit(1);
  }

  console.log(
    `Dependency advisory gate passed: ${advisories.size} root advisories, ` +
      `${exceptions.size} documented exception(s) inside their validity window.`,
  );
  console.log(
    `npm audit totals: ${counts.high ?? 0} high, ${counts.critical ?? 0} critical, ` +
      `${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low, ${counts.info ?? 0} info.`,
  );
  for (const note of notes) console.log(` note: ${note}`);
};

main().catch((error) => {
  console.error(`Dependency advisory gate crashed: ${error.message}`);
  process.exit(1);
});
