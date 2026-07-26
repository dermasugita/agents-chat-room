import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = resolve(PACKAGE_ROOT, "package.json");
const CHANGELOG_PATH = resolve(PACKAGE_ROOT, "CHANGELOG.md");

export function packageVersion() {
  return JSON.parse(readFileSync(PACKAGE_PATH, "utf8")).version;
}

export function releaseNotes(version = packageVersion()) {
  const changelog = readFileSync(CHANGELOG_PATH, "utf8");
  const heading = new RegExp(
    `^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\](?: .*)?$`,
    "m",
  );
  const match = heading.exec(changelog);
  if (!match) {
    throw new Error(`CHANGELOG.md has no release notes for ${version}`);
  }
  const start = match.index;
  const remainder = changelog.slice(start + match[0].length);
  const next = remainder.search(/^## /m);
  return changelog
    .slice(start, next < 0 ? changelog.length : start + match[0].length + next)
    .trim();
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    return match ? match.slice(1).map(Number) : null;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) {
    return 0;
  }
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}
