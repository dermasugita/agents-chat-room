#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDatabase } from "./lib/database-snapshot.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = {
  image: "agents-chat-room:0.1.0",
  name: "agents-chat-room",
  port: "7331",
  stateDir: join(homedir(), ".local", "share", "agents-chat-room"),
  backupIntervalMinutes: 15,
  backupGenerations: 192,
  dryRun: false,
  skipBuild: false,
};

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--dry-run") {
    options.dryRun = true;
    continue;
  }
  if (argument === "--skip-build") {
    options.skipBuild = true;
    continue;
  }
  if (argument === "--help") {
    console.log(
      "Usage: deploy.mjs [--image IMAGE] [--name NAME] [--port PORT] [--state-dir ABSOLUTE_PATH] [--backup-interval-minutes 15] [--backup-generations 192] [--skip-build] [--dry-run]",
    );
    process.exit(0);
  }
  const match = argument.match(
    /^--(image|name|port|state-dir|backup-interval-minutes|backup-generations)(?:=(.*))?$/,
  );
  if (!match) {
    console.error(`deploy: unknown argument: ${argument}`);
    process.exit(64);
  }
  const value = match[2] ?? args[++index];
  if (!value || value.startsWith("--")) {
    console.error(`deploy: --${match[1]} requires a value`);
    process.exit(64);
  }
  const key = match[1].replace(/-([a-z])/g, (_, letter) =>
    letter.toUpperCase(),
  );
  options[key] = value;
}

if (
  !/^\d+$/.test(options.port) ||
  Number(options.port) < 1 ||
  Number(options.port) > 65535
) {
  console.error("deploy: --port must be an integer from 1 to 65535");
  process.exit(64);
}
for (const key of ["backupIntervalMinutes", "backupGenerations"]) {
  const value = Number(options[key]);
  if (!Number.isInteger(value) || value < 1) {
    const flag =
      key === "backupIntervalMinutes"
        ? "backup-interval-minutes"
        : "backup-generations";
    console.error(`deploy: --${flag} must be a positive integer`);
    process.exit(64);
  }
  options[key] = value;
}
if (
  !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.name)
) {
  console.error("deploy: --name contains unsupported characters");
  process.exit(64);
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(options.image)) {
  console.error("deploy: --image contains unsupported characters");
  process.exit(64);
}
if (
  !isAbsolute(options.stateDir) ||
  options.stateDir.includes(",")
) {
  console.error(
    "deploy: --state-dir must be an absolute path without commas",
  );
  process.exit(64);
}
options.stateDir = resolve(options.stateDir);

const branchResult = spawnSync("git", ["branch", "--show-current"], {
  cwd: repository,
  encoding: "utf8",
});
if (branchResult.error || branchResult.status !== 0) {
  console.error(
    `deploy: cannot determine git branch: ${
      branchResult.error?.message ?? branchResult.stderr.trim()
    }`,
  );
  process.exit(64);
}
const branch = branchResult.stdout.trim();
if (branch !== "main") {
  console.error(
    `deploy: production deployment requires branch main; current branch is ${branch || "detached HEAD"}`,
  );
  process.exit(64);
}

if (!options.dryRun) {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
}

function captureDocker(commandArgs) {
  return spawnSync("docker", commandArgs, {
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
  });
}

function migrateExistingDatabase() {
  const destination = join(options.stateDir, "ao.sqlite");
  if (options.dryRun || existsSync(destination)) {
    return;
  }
  const inspection = captureDocker(["container", "inspect", options.name]);
  if (inspection.error) {
    console.error(`deploy: cannot inspect existing container: ${inspection.error.message}`);
    process.exit(1);
  }
  if (inspection.status !== 0) {
    if (/No such (?:object|container)/i.test(inspection.stderr)) {
      return;
    }
    console.error(
      `deploy: cannot inspect existing container: ${inspection.stderr.trim()}`,
    );
    process.exit(1);
  }

  const containerSnapshot = "/tmp/ao-deploy-migration.sqlite";
  const migrationProgram = `
    const { existsSync, unlinkSync } = require("node:fs");
    const { DatabaseSync } = require("node:sqlite");
    const source = process.env.AO_DATABASE_PATH || "/data/ao.sqlite";
    const destination = ${JSON.stringify(containerSnapshot)};
    if (existsSync(destination)) unlinkSync(destination);
    const database = new DatabaseSync(source, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("VACUUM INTO '" + destination.replaceAll("'", "''") + "'");
    } finally {
      database.close();
    }
  `;
  const snapshot = captureDocker([
    "exec",
    options.name,
    "node",
    "-e",
    migrationProgram,
  ]);
  if (snapshot.error || snapshot.status !== 0) {
    console.error(
      `deploy: cannot snapshot existing database: ${
        snapshot.error?.message ?? snapshot.stderr.trim()
      }`,
    );
    process.exit(1);
  }

  const temporary = `${destination}.migration-${process.pid}`;
  if (existsSync(temporary)) {
    unlinkSync(temporary);
  }
  const copied = captureDocker([
    "cp",
    `${options.name}:${containerSnapshot}`,
    temporary,
  ]);
  if (copied.error || copied.status !== 0) {
    console.error(
      `deploy: cannot copy existing database snapshot: ${
        copied.error?.message ?? copied.stderr.trim()
      }`,
    );
    process.exit(1);
  }
  chmodSync(temporary, 0o600);

  let report;
  try {
    report = inspectDatabase(temporary);
  } catch (error) {
    unlinkSync(temporary);
    console.error(`deploy: cannot validate migrated database: ${error.message}`);
    process.exit(1);
  }
  if (
    report.content_rows === 0 ||
    report.foreign_key_issues.length > 0
  ) {
    unlinkSync(temporary);
    console.error(
      "deploy: migrated database is empty or failed foreign-key validation",
    );
    process.exit(1);
  }
  renameSync(temporary, destination);
  console.log(
    JSON.stringify({
      event: "migrated_existing_database",
      source_container: options.name,
      destination,
      total_rows: report.total_rows,
      content_rows: report.content_rows,
      tables: report.tables,
    }),
  );
}

function run(commandArgs, { allowFailure = false } = {}) {
  console.log(JSON.stringify(["docker", ...commandArgs]));
  if (options.dryRun) {
    return;
  }
  const result = spawnSync("docker", commandArgs, {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`deploy: cannot start docker: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0 && !allowFailure) {
    process.exit(result.status ?? 1);
  }
}

const containerUser = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
const backupName = `${options.name}-backup`;
const stateMount =
  `type=bind,source=${options.stateDir},target=/var/lib/agents-chat-room`;

migrateExistingDatabase();
if (!options.skipBuild) {
  run([
    "build",
    "--platform",
    "linux/amd64",
    "--tag",
    options.image,
    repository,
  ]);
}
run(["rm", "--force", backupName], { allowFailure: true });
run(["rm", "--force", options.name], { allowFailure: true });
run([
  "run",
  "--detach",
  "--name",
  options.name,
  "--restart",
  "unless-stopped",
  "--platform",
  "linux/amd64",
  "--user",
  containerUser,
  "--publish",
  `127.0.0.1:${options.port}:7331`,
  "--mount",
  stateMount,
  "--env",
  "AO_DATABASE_PATH=/var/lib/agents-chat-room/ao.sqlite",
  options.image,
]);
run([
  "run",
  "--detach",
  "--name",
  backupName,
  "--restart",
  "unless-stopped",
  "--platform",
  "linux/amd64",
  "--user",
  containerUser,
  "--mount",
  `${stateMount},readonly`,
  "--mount",
  "type=bind,source=/data,target=/backups",
  options.image,
  "node",
  "scripts/backup-loop.mjs",
  "--source",
  "/var/lib/agents-chat-room/ao.sqlite",
  "--destination-dir",
  `/backups/${options.name}`,
  "--interval-minutes",
  String(options.backupIntervalMinutes),
  "--keep",
  String(options.backupGenerations),
  "--require-nfs",
]);
