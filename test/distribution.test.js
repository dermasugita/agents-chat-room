import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { createDatabase } from "../src/db.js";
import { listen } from "../src/server.js";
import { createStore } from "../src/store.js";

const execFileAsync = promisify(execFile);

test("direct startup defaults to the IPv4 loopback interface", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ao-bind-test-"));
  const originalLog = console.log;
  console.log = () => {};
  let application;
  try {
    application = await listen({
      databasePath: join(directory, "bind.sqlite"),
      port: 0,
    });
    assert.equal(application.server.address().address, "127.0.0.1");
  } finally {
    console.log = originalLog;
    if (application) {
      await new Promise((resolveClose) =>
        application.server.close(resolveClose),
      );
      application.database.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Docker distribution fixes host publication to loopback", () => {
  const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
  const compose = readFileSync(resolve("compose.yaml"), "utf8");
  const readme = readFileSync(resolve("README.md"), "utf8");
  assert.match(dockerfile, /AO_BIND=0\.0\.0\.0/);
  assert.match(compose, /host_ip:\s*127\.0\.0\.1/);
  assert.match(readme, /--publish 127\.0\.0\.1:7331:7331/);
  for (const content of [dockerfile, compose, readme]) {
    assert.doesNotMatch(content, /(?:--publish|-p)\s+\d+:\d+/);
  }
});

test("deploy script can only construct a loopback Docker publication", async () => {
  const script = resolve("scripts/deploy.mjs");
  const result = await execFileAsync(
    process.execPath,
    [
      script,
      "--dry-run",
      "--image",
      "agents-chat-room:probe",
      "--name",
      "ao-probe",
      "--port",
      "28100",
      "--volume",
      "ao-probe-data",
    ],
    { cwd: resolve(".") },
  );
  const commands = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(commands.length, 3);
  const run = commands.find((command) => command[1] === "run");
  const publish = run.indexOf("--publish");
  assert.equal(run[publish + 1], "127.0.0.1:28100:7331");
  assert.notEqual(statSync(script).mode & 0o111, 0);
});

test("backup script includes live WAL data and reports table counts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ao-backup-test-"));
  const source = join(directory, "source.sqlite");
  const destination = join(directory, "backup.sqlite");
  const database = createDatabase(source);
  try {
    const store = createStore(database);
    store.createProject({ slug: "backup", name: "Backup" });
    store.createWork("backup", { slug: "work", title: "Work" });
    store.createDocument("backup", {
      kind: "context",
      title: "Context",
      body: "WAL-backed content",
      author: "designer",
    });
    store.postMessage("backup", "work", {
      idempotency_key: crypto.randomUUID(),
      from: "designer",
      role: "designer",
      type: "status",
      body: "Live WAL message",
      to: [],
      refs: [],
    });

    assert.equal(existsSync(`${source}-wal`), true);
    assert.ok(statSync(`${source}-wal`).size > 0);
    const result = await execFileAsync(
      process.execPath,
      [resolve("scripts/backup-db.mjs"), source, destination],
      { cwd: resolve(".") },
    );
    const report = JSON.parse(result.stdout);
    assert.equal(report.method, "VACUUM INTO");
    assert.ok(report.total_rows > 0);
    assert.ok(report.content_rows > 0);
    assert.equal(
      report.tables.find(({ name }) => name === "project").count,
      1,
    );
    assert.equal(
      report.tables.find(({ name }) => name === "work").count,
      1,
    );
    assert.equal(
      report.tables.find(({ name }) => name === "message").count,
      1,
    );

    const copied = new DatabaseSync(destination, { readOnly: true });
    try {
      assert.equal(copied.prepare("SELECT COUNT(*) AS count FROM project").get().count, 1);
      assert.equal(copied.prepare("SELECT COUNT(*) AS count FROM message").get().count, 1);
      assert.equal(
        copied.prepare("SELECT body FROM message").get().body,
        "Live WAL message",
      );
    } finally {
      copied.close();
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("backup script rejects a schema-only database after reporting every table", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ao-empty-backup-test-"));
  const source = join(directory, "source.sqlite");
  const destination = join(directory, "backup.sqlite");
  const database = createDatabase(source);
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [resolve("scripts/backup-db.mjs"), source, destination],
        { cwd: resolve(".") },
      ),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /contains no domain rows/);
        const report = JSON.parse(error.stdout);
        assert.equal(report.content_rows, 0);
        assert.ok(report.tables.some(({ name }) => name === "schema_meta"));
        assert.ok(report.tables.every(({ count }) => count >= 0));
        return true;
      },
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI package declares the measured minimum Node version", () => {
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.equal(packageJson.engines.node, ">=22.14.0");
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.bin.ao, "bin/ao.js");
});
