#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

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
const sourceDatabase = new DatabaseSync(source, { readOnly: true });
try {
  sourceDatabase.exec("PRAGMA busy_timeout = 5000");
  const destinationLiteral = destination.replaceAll("'", "''");
  sourceDatabase.exec(`VACUUM INTO '${destinationLiteral}'`);
} finally {
  sourceDatabase.close();
}

const backupDatabase = new DatabaseSync(destination, { readOnly: true });
const tables = [];
try {
  const rows = backupDatabase
    .prepare(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all();
  for (const { name } of rows) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const count = backupDatabase
      .prepare(`SELECT COUNT(*) AS count FROM ${quoted}`)
      .get().count;
    tables.push({ name, count });
  }
} finally {
  backupDatabase.close();
}

const totalRows = tables.reduce((total, table) => total + Number(table.count), 0);
const contentRows = tables
  .filter(({ name }) => name !== "schema_meta")
  .reduce((total, table) => total + Number(table.count), 0);
const report = {
  source,
  destination,
  method: "VACUUM INTO",
  total_rows: totalRows,
  content_rows: contentRows,
  tables,
};
console.log(JSON.stringify(report, null, 2));

if (tables.length === 0 || contentRows === 0) {
  console.error(
    `backup-db: backup contains no domain rows: ${destination}`,
  );
  process.exit(2);
}
