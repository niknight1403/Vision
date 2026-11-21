#!/usr/bin/env node
/**
 * Write provenance for generated release artifacts without claiming a release.
 * Usage: node scripts/release-evidence.mjs <artifact-directory> <output-json>
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const [artifactArg, outputArg] = process.argv.slice(2);
if (!artifactArg || !outputArg) {
  console.error("usage: node scripts/release-evidence.mjs <artifact-directory> <output-json>");
  process.exit(2);
}
const artifactDirectory = resolve(artifactArg);
const outputPath = resolve(outputArg);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

const files = await filesUnder(artifactDirectory);
const artifacts = [];
for (const path of files) {
  const content = await readFile(path);
  artifacts.push({
    path: relative(artifactDirectory, path),
    sizeBytes: (await stat(path)).size,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}
const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  buildId: process.env.GITHUB_RUN_ID ? `github-actions:${process.env.GITHUB_RUN_ID}` : `local:${gitSha}`,
  gitSha,
  artifacts,
  productionReady: false,
  liveExecutionEnabled: false,
};
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
