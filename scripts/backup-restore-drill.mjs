#!/usr/bin/env node
/**
 * Backup/restore drill for the AutonomAgent PostgreSQL database.
 *
 * Proves that a dump can be restored into a scratch database and that the restore
 * is complete: same tables, same row counts, same applied migrations. It never
 * writes to the source database, never restores over an existing database and
 * always drops the scratch database again.
 *
 * Usage:
 *   DATABASE_URL=postgresql://user:pass@host:5432/db node scripts/backup-restore-drill.mjs
 *
 * Options (environment):
 *   PG_BIN        directory containing pg_dump/psql/pg_restore (default: autodetect)
 *   DRILL_KEEP=1  keep the scratch database and the dump file for inspection
 *
 * Exit codes: 0 drill passed, 1 drill failed, 2 configuration problem.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error("backup-restore-drill: DATABASE_URL is required; no restore evidence claimed.");
  process.exit(2);
}

let url;
try {
  url = new URL(rawUrl);
} catch {
  console.error("backup-restore-drill: DATABASE_URL is invalid.");
  process.exit(2);
}
if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
  console.error("backup-restore-drill: DATABASE_URL must use postgresql:// or postgres://.");
  process.exit(2);
}

const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (!database) {
  console.error("backup-restore-drill: DATABASE_URL carries no database name.");
  process.exit(2);
}
const scratchDatabase = `${database}_restore_drill_${process.pid}`;
if (!/^[A-Za-z0-9_]+$/.test(scratchDatabase)) {
  console.error("backup-restore-drill: refusing an unsafe scratch database name.");
  process.exit(2);
}

/**
 * Connection settings are taken apart instead of handing DATABASE_URL to libpq:
 * Prisma appends `?schema=public` (libpq rejects unknown URI parameters) and the
 * psql-family tools do not reliably treat a positional database argument as a
 * connection string. Host/port/user go in as flags, the password only via
 * PGPASSWORD so it never appears in argv or in the report.
 */
const connection = {
  host: url.hostname || url.searchParams.get("host") || "",
  port: url.port || "5432",
  user: url.username ? decodeURIComponent(url.username) : "",
  password: url.password ? decodeURIComponent(url.password) : "",
};

function connectionFlags() {
  const flags = [];
  if (connection.host) flags.push("--host", connection.host);
  flags.push("--port", connection.port);
  if (connection.user) flags.push("--username", connection.user);
  return flags;
}

/** Connection options for tools that accept --dbname (pg_dump, psql, pg_restore). */
function connectionArgs(targetDatabase) {
  return [...connectionFlags(), "--dbname", targetDatabase];
}

/** Connection options for createdb/dropdb, which take the target database positionally. */
function positionalDatabaseArgs(targetDatabase) {
  return [...connectionFlags(), "--maintenance-db", database, targetDatabase];
}

function toolEnv() {
  const env = { ...process.env, PGCONNECT_TIMEOUT: "10" };
  if (connection.password) env.PGPASSWORD = connection.password;
  return env;
}

class DrillFailure extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function resolveBin(name) {
  if (process.env.PG_BIN) return join(process.env.PG_BIN, name);
  const roots = ["/usr/lib/postgresql", "/usr/local/pgsql"];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root).filter((entry) => /^\d+$/.test(entry)).sort((a, b) => Number(b) - Number(a));
    for (const version of versions) {
      const candidate = join(root, version, "bin", name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}

const pgDump = resolveBin("pg_dump");
const psql = resolveBin("psql");
const pgRestore = resolveBin("pg_restore");
const createdb = resolveBin("createdb");
const dropdb = resolveBin("dropdb");

function run(bin, args, { allowFailure = false } = {}) {
  const result = spawnSync(bin, args, { encoding: "utf8", env: toolEnv() });
  if (result.error) {
    throw new DrillFailure(`cannot run ${bin}: ${result.error.message}`, 2);
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr ?? "").trim().slice(0, 2000);
    throw new DrillFailure(`${bin} ${args.join(" ")} failed (exit ${result.status})${detail ? `: ${detail}` : ""}`, 1);
  }
  return result;
}

/** Per-table row counts and the applied migration list of one database. */
function inspect(targetDatabase) {
  const query = (sql) => {
    const result = spawnSync(psql, [...connectionArgs(targetDatabase), "-v", "ON_ERROR_STOP=1", "-tAF", "\t", "-c", sql], {
      encoding: "utf8",
      env: toolEnv(),
    });
    if (result.status !== 0) {
      throw new DrillFailure(
        `inspection query failed for ${targetDatabase}: ${(result.stderr ?? "").trim()}`,
        1,
      );
    }
    return result.stdout.trim();
  };

  const tables = query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  )
    .split("\n")
    .filter(Boolean);
  const counts = {};
  for (const table of tables) {
    counts[table] = Number(query(`SELECT count(*) FROM "${table}"`));
  }
  const migrations = query(
    "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL ORDER BY migration_name",
  )
    .split("\n")
    .filter(Boolean);
  return { tables, counts, migrations };
}

const workDir = mkdtempSync(join(tmpdir(), "autonomagent-restore-drill-"));
const dumpPath = join(workDir, "backup.dump");
const report = { database, scratchDatabase, startedAt: new Date().toISOString() };
let scratchCreated = false;

function cleanup() {
  if (process.env.DRILL_KEEP === "1") {
    console.log(`backup-restore-drill: kept ${dumpPath} and ${scratchDatabase}`);
    return;
  }
  if (scratchCreated) run(dropdb, [...connectionFlags(), "--if-exists", "--maintenance-db", database, scratchDatabase], { allowFailure: true });
  rmSync(workDir, { recursive: true, force: true });
}

try {
  console.log(`backup-restore-drill: dumping ${database}`);
  run(pgDump, ["--format=custom", "--no-owner", "--no-privileges", "--file", dumpPath, ...connectionArgs(database)]);
  const dumpBytes = statSync(dumpPath).size;
  const dumpSha256 = createHash("sha256").update(readFileSync(dumpPath)).digest("hex");
  report.dump = { bytes: dumpBytes, sha256: dumpSha256 };
  if (dumpBytes === 0) throw new Error("dump is empty");

  console.log(`backup-restore-drill: creating ${scratchDatabase}`);
  run(createdb, positionalDatabaseArgs(scratchDatabase));
  scratchCreated = true;

  console.log(`backup-restore-drill: restoring into ${scratchDatabase}`);
  const restore = run(
    pgRestore,
    ["--no-owner", "--no-privileges", "--exit-on-error", ...connectionArgs(scratchDatabase), dumpPath],
    { allowFailure: true },
  );
  if (restore.status !== 0) {
    // A custom-format dump restored with --exit-on-error reports the first real
    // problem; surface it instead of pretending the restore worked.
    throw new Error(`pg_restore exited ${restore.status}: ${(restore.stderr ?? "").trim().slice(0, 500)}`);
  }

  const source = inspect(database);
  const restored = inspect(scratchDatabase);
  report.tables = source.tables.length;
  report.rows = Object.values(source.counts).reduce((total, value) => total + value, 0);
  report.migrations = source.migrations.length;
  report.restored = {
    tables: restored.tables.length,
    rows: Object.values(restored.counts).reduce((total, value) => total + value, 0),
    migrations: restored.migrations.length,
  };

  const problems = [];
  const missingTables = source.tables.filter((table) => !restored.tables.includes(table));
  const extraTables = restored.tables.filter((table) => !source.tables.includes(table));
  if (missingTables.length > 0) problems.push(`tables missing after restore: ${missingTables.join(", ")}`);
  if (extraTables.length > 0) problems.push(`unexpected tables after restore: ${extraTables.join(", ")}`);
  for (const table of source.tables) {
    if (restored.counts[table] !== source.counts[table]) {
      problems.push(`row count mismatch on ${table}: source ${source.counts[table]}, restored ${restored.counts[table]}`);
    }
  }
  if (source.migrations.join(",") !== restored.migrations.join(",")) {
    problems.push("applied migration list differs after restore");
  }
  if (source.migrations.length === 0) problems.push("no applied migrations found in the source database");

  report.finishedAt = new Date().toISOString();
  report.status = problems.length === 0 ? "PASSED" : "FAILED";
  report.problems = problems;
  report.tableCounts = source.counts;
  console.log(JSON.stringify(report, null, 2));

  if (problems.length > 0) {
    console.error("backup-restore-drill: FAILED");
    for (const problem of problems) console.error(` - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      `backup-restore-drill: PASSED (${report.tables} tables, ${report.rows} rows, ` +
        `${report.migrations} migrations, dump ${dumpBytes} bytes sha256 ${dumpSha256.slice(0, 16)}…)`,
    );
  }
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.status = "FAILED";
  report.problems = [error instanceof Error ? error.message : String(error)];
  console.error(JSON.stringify(report, null, 2));
  console.error("backup-restore-drill: FAILED");
  process.exitCode = error instanceof DrillFailure ? error.exitCode : 1;
} finally {
  cleanup();
}
