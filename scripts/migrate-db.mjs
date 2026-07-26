#!/usr/bin/env node

import { existsSync, unlinkSync } from "node:fs";
import {
  inspectDatabase,
  tableCountsMatch,
  vacuumInto,
} from "./lib/database-snapshot.mjs";

const [source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length > 0) {
  console.error("Usage: migrate-db.mjs SOURCE DESTINATION");
  process.exit(64);
}
if (existsSync(destination)) {
  console.error(`migrate-db: destination already exists: ${destination}`);
  process.exit(2);
}

let sourceReport;
let destinationReport;
try {
  sourceReport = inspectDatabase(source);
  if (
    sourceReport.content_rows === 0 ||
    sourceReport.foreign_key_issues.length > 0
  ) {
    throw new Error("source is empty or failed foreign-key validation");
  }
  vacuumInto(source, destination);
  destinationReport = inspectDatabase(destination);
  if (
    destinationReport.foreign_key_issues.length > 0 ||
    !tableCountsMatch(sourceReport, destinationReport)
  ) {
    throw new Error("snapshot table counts do not match the source");
  }
} catch (error) {
  if (existsSync(destination)) {
    unlinkSync(destination);
  }
  console.error(`migrate-db: ${error.message}`);
  process.exit(2);
}

console.log(
  JSON.stringify({
    method: "VACUUM INTO",
    counts_match: true,
    source: sourceReport,
    destination: destinationReport,
  }),
);
