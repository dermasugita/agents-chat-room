#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NFS_SUPER_MAGIC,
  storageUsage,
} from "./lib/database-snapshot.mjs";

const backupScript = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "backup-db.mjs",
);
const options = {
  source: undefined,
  destinationDir: undefined,
  intervalMinutes: 15,
  keep: 192,
  once: false,
  requireNfs: false,
};

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--once") {
    options.once = true;
    continue;
  }
  if (argument === "--require-nfs") {
    options.requireNfs = true;
    continue;
  }
  const match = argument.match(
    /^--(source|destination-dir|interval-minutes|keep)(?:=(.*))?$/,
  );
  if (!match) {
    console.error(`backup-loop: unknown argument: ${argument}`);
    process.exit(64);
  }
  const value = match[2] ?? args[++index];
  if (!value || value.startsWith("--")) {
    console.error(`backup-loop: --${match[1]} requires a value`);
    process.exit(64);
  }
  const key = match[1].replace(/-([a-z])/g, (_, letter) =>
    letter.toUpperCase(),
  );
  options[key] = value;
}

if (!options.source || !options.destinationDir) {
  console.error(
    "Usage: backup-loop.mjs --source SOURCE --destination-dir DIR [--interval-minutes 15] [--keep 192] [--once] [--require-nfs]",
  );
  process.exit(64);
}
for (const key of ["intervalMinutes", "keep"]) {
  const value = Number(options[key]);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`backup-loop: --${key === "keep" ? "keep" : "interval-minutes"} must be a positive integer`);
    process.exit(64);
  }
  options[key] = value;
}
options.source = resolve(options.source);
options.destinationDir = resolve(options.destinationDir);

function generationName() {
  const compact = new Date().toISOString().replace(/[-:TZ.]/g, "");
  return `ao-${compact.slice(0, 8)}-${compact.slice(8)}-${randomUUID().slice(0, 8)}.sqlite`;
}

function pruneGenerations() {
  const generations = readdirSync(options.destinationDir, {
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^ao-\d{8}-\d{9}-[0-9a-f]{8}\.sqlite$/.test(entry.name),
    )
    .map((entry) => {
      const path = join(options.destinationDir, entry.name);
      return {
        name: entry.name,
        path,
        modified: statSync(path).mtimeMs,
      };
    })
    .sort(
      (left, right) =>
        left.modified - right.modified || left.name.localeCompare(right.name),
    );
  const removed = generations.slice(0, Math.max(0, generations.length - options.keep));
  for (const generation of removed) {
    unlinkSync(generation.path);
  }
  return {
    removed: removed.map(({ name }) => name),
    retained: generations.length - removed.length,
  };
}

function assertBackupFilesystem() {
  const usage = storageUsage(options.destinationDir);
  if (
    options.requireNfs &&
    usage.filesystem_type !== NFS_SUPER_MAGIC
  ) {
    throw new Error(
      `backup destination is not NFS: ${usage.path} filesystem_type=0x${usage.filesystem_type.toString(16)}`,
    );
  }
  return usage;
}

function sourceStorageStatus() {
  const usage = storageUsage(dirname(options.source));
  return {
    usage,
    low:
      usage.available_bytes < 5 * 1024 * 1024 * 1024 ||
      usage.available_percent < 10,
  };
}

function runBackup() {
  const backupStorage = assertBackupFilesystem();
  mkdirSync(options.destinationDir, { recursive: true, mode: 0o700 });
  const destination = join(options.destinationDir, generationName());
  const result = spawnSync(
    process.execPath,
    [backupScript, options.source, destination],
    {
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `backup-db exited ${result.status}`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join(": "),
    );
  }
  const backup = JSON.parse(result.stdout);
  const retention = pruneGenerations();
  const sourceStorage = sourceStorageStatus();
  console.log(
    JSON.stringify({
      event: "backup_ok",
      ts: new Date().toISOString(),
      backup,
      backup_storage: backupStorage,
      retained_generations: retention.retained,
      pruned_generations: retention.removed,
      source_storage: sourceStorage.usage,
      source_low_space: sourceStorage.low,
    }),
  );
}

function reportFailure(error) {
  let sourceStorage;
  try {
    sourceStorage = sourceStorageStatus();
  } catch {
    sourceStorage = undefined;
  }
  console.error(
    JSON.stringify({
      event: "backup_failed",
      ts: new Date().toISOString(),
      error: error.message,
      ...(sourceStorage
        ? {
            source_storage: sourceStorage.usage,
            source_low_space: sourceStorage.low,
          }
        : {}),
    }),
  );
}

if (options.once) {
  try {
    runBackup();
  } catch (error) {
    reportFailure(error);
    process.exit(1);
  }
} else {
  while (true) {
    try {
      runBackup();
    } catch (error) {
      reportFailure(error);
    }
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, options.intervalMinutes * 60_000),
    );
  }
}
