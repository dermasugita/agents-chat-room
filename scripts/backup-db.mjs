#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  inspectDatabase,
  storageUsage,
  vacuumInto,
} from "./lib/database-snapshot.mjs";

const [sourceValue, destinationValue] = process.argv.slice(2);
if (!sourceValue || !destinationValue) {
  console.error("Usage: backup-db.mjs <source.sqlite> <destination.sqlite>");
  process.exit(64);
}

const source = resolve(sourceValue);
const destination = resolve(destinationValue);
if (source === destination) {
  console.error("backup-db: source and destination must differ");
  process.exit(64);
}
if (!existsSync(source)) {
  console.error(`backup-db: source does not exist: ${source}`);
  process.exit(1);
}
if (existsSync(destination)) {
  console.error(`backup-db: destination already exists: ${destination}`);
  process.exit(1);
}

await mkdir(dirname(destination), { recursive: true });
const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;
let inspection;
try {
  vacuumInto(source, temporary);
  inspection = inspectDatabase(temporary);
} catch (error) {
  if (existsSync(temporary)) {
    unlinkSync(temporary);
  }
  console.error(`backup-db: snapshot failed: ${error.message}`);
  process.exit(1);
}

const report = {
  source,
  destination,
  method: "VACUUM INTO",
  total_rows: inspection.total_rows,
  content_rows: inspection.content_rows,
  tables: inspection.tables,
  foreign_key_issues: inspection.foreign_key_issues,
  source_storage: storageUsage(dirname(source)),
};

if (
  inspection.tables.length === 0 ||
  inspection.content_rows === 0 ||
  inspection.foreign_key_issues.length > 0
) {
  console.log(JSON.stringify(report, null, 2));
  unlinkSync(temporary);
  console.error(
    inspection.foreign_key_issues.length > 0
      ? `backup-db: backup failed foreign-key validation: ${destination}`
      : `backup-db: backup contains no domain rows: ${destination}`,
  );
  process.exit(2);
}

try {
  renameSync(temporary, destination);
} catch (error) {
  if (existsSync(temporary)) {
    unlinkSync(temporary);
  }
  console.error(`backup-db: cannot publish snapshot: ${error.message}`);
  process.exit(1);
}
console.log(JSON.stringify(report, null, 2));
