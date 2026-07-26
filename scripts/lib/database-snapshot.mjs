import { existsSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const NFS_SUPER_MAGIC = 0x6969;

function quotedIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqliteLiteral(value) {
  return value.replaceAll("'", "''");
}

export function inspectDatabase(pathValue) {
  const path = resolve(pathValue);
  const database = new DatabaseSync(path, { readOnly: true });
  const tables = [];
  let foreignKeyIssues;
  try {
    const rows = database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all();
    for (const { name } of rows) {
      const count = database
        .prepare(`SELECT COUNT(*) AS count FROM ${quotedIdentifier(name)}`)
        .get().count;
      tables.push({ name, count: Number(count) });
    }
    foreignKeyIssues = database
      .prepare("PRAGMA foreign_key_check")
      .all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }

  const totalRows = tables.reduce((total, table) => total + table.count, 0);
  const contentRows = tables
    .filter(({ name }) => name !== "schema_meta")
    .reduce((total, table) => total + table.count, 0);
  return {
    path,
    total_rows: totalRows,
    content_rows: contentRows,
    tables,
    foreign_key_issues: foreignKeyIssues,
  };
}

export function vacuumInto(sourceValue, destinationValue) {
  const source = resolve(sourceValue);
  const destination = resolve(destinationValue);
  const sourceDatabase = new DatabaseSync(source, { readOnly: true });
  try {
    sourceDatabase.exec("PRAGMA busy_timeout = 5000");
    sourceDatabase.exec(`VACUUM INTO '${sqliteLiteral(destination)}'`);
  } finally {
    sourceDatabase.close();
  }
}

export function tableCountsMatch(first, second) {
  return (
    JSON.stringify(first.tables) === JSON.stringify(second.tables) &&
    first.total_rows === second.total_rows &&
    first.content_rows === second.content_rows
  );
}

export function storageUsage(pathValue) {
  let probe = resolve(pathValue);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) {
      break;
    }
    probe = parent;
  }
  const stats = statfsSync(probe, { bigint: true });
  const totalBytes = stats.blocks * stats.bsize;
  const availableBytes = stats.bavail * stats.bsize;
  const usedBytes = totalBytes - stats.bfree * stats.bsize;
  const usedPercent =
    totalBytes === 0n
      ? 0
      : Math.round((Number(usedBytes) / Number(totalBytes)) * 10_000) / 100;
  const availablePercent =
    totalBytes === 0n
      ? 0
      : Math.round((Number(availableBytes) / Number(totalBytes)) * 10_000) /
        100;
  return {
    path: probe,
    filesystem_type: Number(stats.type),
    total_bytes: Number(totalBytes),
    available_bytes: Number(availableBytes),
    available_percent: availablePercent,
    used_percent: usedPercent,
  };
}
