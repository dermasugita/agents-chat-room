#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  inspectDatabase,
  storageUsage,
  tableCountsMatch,
  vacuumInto,
} from "./lib/database-snapshot.mjs";

const [sourceValue, destinationValue] = process.argv.slice(2);
if (!sourceValue || !destinationValue) {
  console.error("Usage: restore-db.mjs <backup.sqlite> <destination.sqlite>");
  process.exit(64);
}

const source = resolve(sourceValue);
const destination = resolve(destinationValue);
if (source === destination) {
  console.error("restore-db: source and destination must differ");
  process.exit(64);
}
if (!existsSync(source)) {
  console.error(`restore-db: backup does not exist: ${source}`);
  process.exit(1);
}
if (existsSync(destination)) {
  console.error(`restore-db: destination already exists: ${destination}`);
  process.exit(1);
}

let sourceInspection;
try {
  sourceInspection = inspectDatabase(source);
} catch (error) {
  console.error(`restore-db: cannot inspect backup: ${error.message}`);
  process.exit(2);
}
if (
  sourceInspection.tables.length === 0 ||
  sourceInspection.content_rows === 0 ||
  sourceInspection.foreign_key_issues.length > 0
) {
  console.error(
    sourceInspection.foreign_key_issues.length > 0
      ? "restore-db: backup failed foreign-key validation"
      : "restore-db: backup contains no domain rows",
  );
  process.exit(2);
}

await mkdir(dirname(destination), { recursive: true });
const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;
let restoredInspection;
try {
  vacuumInto(source, temporary);
  restoredInspection = inspectDatabase(temporary);
} catch (error) {
  if (existsSync(temporary)) {
    unlinkSync(temporary);
  }
  console.error(`restore-db: restore failed: ${error.message}`);
  process.exit(2);
}

if (
  restoredInspection.foreign_key_issues.length > 0 ||
  !tableCountsMatch(sourceInspection, restoredInspection)
) {
  unlinkSync(temporary);
  console.error("restore-db: restored table counts do not match the backup");
  process.exit(2);
}

try {
  renameSync(temporary, destination);
} catch (error) {
  if (existsSync(temporary)) {
    unlinkSync(temporary);
  }
  console.error(`restore-db: cannot publish restored database: ${error.message}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      source,
      destination,
      method: "VACUUM INTO",
      counts_match: true,
      total_rows: restoredInspection.total_rows,
      content_rows: restoredInspection.content_rows,
      tables: restoredInspection.tables,
      foreign_key_issues: restoredInspection.foreign_key_issues,
      source_storage: storageUsage(dirname(source)),
      destination_storage: storageUsage(dirname(destination)),
    },
    null,
    2,
  ),
);
