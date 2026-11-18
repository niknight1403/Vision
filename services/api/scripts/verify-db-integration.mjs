#!/usr/bin/env node
/**
 * Gate for the PostgreSQL integration suites.
 *
 * The three `*.integration.test.ts` files skip themselves when `DATABASE_URL` is
 * unset. Without an explicit assertion a CI run would stay green while the
 * concurrency, lease and RBAC coverage silently disappeared, so this script
 * fails unless every integration test actually executed.
 *
 * Usage: node scripts/verify-db-integration.mjs <vitest-json-report>
 */
import { readFileSync } from "node:fs";

const INTEGRATION_SUFFIX = ".integration.test.ts";
const EXPECTED_INTEGRATION_FILES = [
  "src/agent-task-service.integration.test.ts",
  "src/app.integration.test.ts",
  "src/wallet-service.integration.test.ts",
];

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: node scripts/verify-db-integration.mjs <vitest-json-report>");
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const files = Array.isArray(report.testResults)
  ? report.testResults
  : Object.values(report.testResults ?? {});

const problems = [];
const summarize = (file) => {
  const assertions = file.assertionResults ?? [];
  const passed = assertions.filter((a) => a.status === "passed").length;
  const pending = assertions.filter((a) => a.status === "pending" || a.status === "skipped").length;
  const failed = assertions.filter((a) => a.status === "failed").length;
  return { assertions, passed, pending, failed };
};

if (!report.success) {
  problems.push(`vitest reported an unsuccessful run (failed tests: ${report.numFailedTests ?? "?"})`);
}
if ((report.numPendingTests ?? 0) > 0) {
  problems.push(`${report.numPendingTests} test(s) were skipped; the database suites must run, not skip`);
}
if ((report.numTodoTests ?? 0) > 0) {
  problems.push(`${report.numTodoTests} test(s) were left as todo`);
}

for (const relativePath of EXPECTED_INTEGRATION_FILES) {
  const file = files.find((candidate) => candidate.name?.endsWith(relativePath));
  if (!file) {
    problems.push(`${relativePath} produced no result at all`);
    continue;
  }
  const { assertions, passed, pending, failed } = summarize(file);
  if (assertions.length === 0) problems.push(`${relativePath} ran zero assertions`);
  if (failed > 0) problems.push(`${relativePath} had ${failed} failing test(s)`);
  if (pending > 0) problems.push(`${relativePath} skipped ${pending} test(s)`);
  if (passed === 0) problems.push(`${relativePath} had no passing test`);
}

const integrationFiles = files.filter((file) => file.name?.endsWith(INTEGRATION_SUFFIX));
const integrationTests = integrationFiles.reduce(
  (total, file) => total + summarize(file).assertions.length,
  0,
);

if (problems.length > 0) {
  console.error("PostgreSQL integration gate failed:");
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}

const total = report.numTotalTests ?? 0;
console.log(
  `PostgreSQL integration gate passed: ${integrationFiles.length} integration files, ` +
    `${integrationTests} integration test(s) executed, ${total} test(s) total with 0 skipped.`,
);
