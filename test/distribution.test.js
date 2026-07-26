import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { createDatabase } from "../src/db.js";
import { listen } from "../src/server.js";
import { createStore } from "../src/store.js";
import {
  NFS_SUPER_MAGIC,
  storageUsage,
} from "../scripts/lib/database-snapshot.mjs";

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
  assert.match(dockerfile, /AO_DATABASE_PATH=\/var\/lib\/agents-chat-room\/ao\.sqlite/);
  assert.doesNotMatch(dockerfile, /^VOLUME/m);
  assert.match(compose, /host_ip:\s*127\.0\.0\.1/);
  assert.match(compose, /type:\s*bind/);
  assert.match(compose, /source:\s*\/data/);
  assert.match(compose, /backup-loop\.mjs/);
  assert.doesNotMatch(compose, /^volumes:/m);
  assert.match(readme, /--publish 127\.0\.0\.1:7331:7331/);
  for (const content of [dockerfile, compose, readme]) {
    assert.doesNotMatch(content, /(?:--publish|-p)\s+\d+:\d+/);
  }
});

function fakeGit(directory, branch) {
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "git");
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${branch}'\n`, "utf8");
  chmodSync(executable, 0o755);
  return bin;
}

function fakeDocker(bin) {
  const executable = join(bin, "docker");
  writeFileSync(
    executable,
    `#!/bin/sh
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  printf '%s\\n' '[{"State":{"Running":true}}]'
  exit 0
fi
if [ "$1" = "exec" ]; then
  exit 0
fi
if [ "$1" = "cp" ]; then
  cp "$FAKE_DOCKER_SNAPSHOT" "$3"
  exit $?
fi
exit 0
`,
    "utf8",
  );
  chmodSync(executable, 0o755);
}

test("deploy script requires main and constructs bind-mounted server and backup containers", async () => {
  const script = resolve("scripts/deploy.mjs");
  const directory = mkdtempSync(join(tmpdir(), "ao-deploy-test-"));
  try {
    const stateDirectory = join(directory, "persistent-state");
    const bin = fakeGit(directory, "main");
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
        "--state-dir",
        stateDirectory,
        "--backup-interval-minutes",
        "15",
        "--backup-generations",
        "192",
      ],
      {
        cwd: resolve("."),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    const commands = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(commands.length, 5);
    assert.equal(
      commands.some(
        (command) => command[1] === "volume" && command[2] === "create",
      ),
      false,
    );
    const runs = commands.filter((command) => command[1] === "run");
    assert.equal(runs.length, 2);
    const server = runs.find(
      (command) => command[command.indexOf("--name") + 1] === "ao-probe",
    );
    const backup = runs.find(
      (command) =>
        command[command.indexOf("--name") + 1] === "ao-probe-backup",
    );
    const publish = server.indexOf("--publish");
    assert.equal(server[publish + 1], "127.0.0.1:28100:7331");
    assert.ok(
      server.includes(
        `type=bind,source=${stateDirectory},target=/var/lib/agents-chat-room`,
      ),
    );
    assert.ok(
      backup.includes(
        `type=bind,source=${stateDirectory},target=/var/lib/agents-chat-room,readonly`,
      ),
    );
    assert.ok(backup.includes("type=bind,source=/data,target=/backups"));
    assert.ok(backup.includes("--require-nfs"));
    assert.equal(
      backup[backup.indexOf("--interval-minutes") + 1],
      "15",
    );
    assert.equal(backup[backup.indexOf("--keep") + 1], "192");
    assert.notEqual(statSync(script).mode & 0o111, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("first bind deployment migrates and validates the existing live database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ao-deploy-migration-test-"));
  const legacySnapshot = join(directory, "legacy.sqlite");
  const stateDirectory = join(directory, "persistent-state");
  const legacy = createDatabase(legacySnapshot);
  try {
    const store = createStore(legacy);
    store.createProject({ slug: "legacy-live", name: "Legacy live" });
    store.createWork("legacy-live", { slug: "work", title: "Work" });
  } finally {
    legacy.close();
  }

  try {
    const bin = fakeGit(directory, "main");
    fakeDocker(bin);
    const result = await execFileAsync(
      process.execPath,
      [
        resolve("scripts/deploy.mjs"),
        "--skip-build",
        "--name",
        "migration-probe",
        "--state-dir",
        stateDirectory,
      ],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          FAKE_DOCKER_SNAPSHOT: legacySnapshot,
          PATH: `${bin}:${process.env.PATH}`,
        },
      },
    );
    const output = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(output[0].event, "migrated_existing_database");
    assert.equal(output[0].content_rows, 2);
    assert.equal(existsSync(legacySnapshot), true);
    const migratedPath = join(stateDirectory, "ao.sqlite");
    assert.equal(existsSync(migratedPath), true);
    const migrated = new DatabaseSync(migratedPath, { readOnly: true });
    try {
      assert.equal(
        migrated.prepare("SELECT COUNT(*) AS count FROM project").get().count,
        1,
      );
      assert.equal(
        migrated.prepare("SELECT COUNT(*) AS count FROM work").get().count,
        1,
      );
      assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deploy script refuses every branch except main", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ao-deploy-branch-test-"));
  try {
    const bin = fakeGit(directory, "work/orchestrator-mvp");
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          resolve("scripts/deploy.mjs"),
          "--dry-run",
          "--state-dir",
          join(directory, "state"),
        ],
        {
          cwd: resolve("."),
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      ),
      (error) => {
        assert.equal(error.code, 64);
        assert.match(error.stderr, /requires branch main/);
        assert.equal(error.stdout, "");
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live WAL backup restores with identical table counts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ao-backup-test-"));
  const source = join(directory, "source.sqlite");
  const destination = join(directory, "backup.sqlite");
  const restored = join(directory, "restored.sqlite");
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
    assert.ok(report.source_storage.available_bytes > 0);
    assert.ok(report.source_storage.available_percent > 0);
    assert.deepEqual(report.foreign_key_issues, []);

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

    const restoreResult = await execFileAsync(
      process.execPath,
      [resolve("scripts/restore-db.mjs"), destination, restored],
      { cwd: resolve(".") },
    );
    const restoreReport = JSON.parse(restoreResult.stdout);
    assert.equal(restoreReport.counts_match, true);
    assert.equal(restoreReport.total_rows, report.total_rows);
    assert.deepEqual(restoreReport.tables, report.tables);
    assert.deepEqual(restoreReport.foreign_key_issues, []);
    const restoredDatabase = new DatabaseSync(restored, { readOnly: true });
    try {
      assert.equal(
        restoredDatabase.prepare("SELECT COUNT(*) AS count FROM message").get()
          .count,
        1,
      );
      assert.equal(
        restoredDatabase.prepare("SELECT body FROM message").get().body,
        "Live WAL message",
      );
    } finally {
      restoredDatabase.close();
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
        assert.equal(existsSync(destination), false);
        assert.equal(
          readdirSync(directory).some((name) => name.includes(".partial-")),
          false,
        );
        return true;
      },
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("periodic backup keeps only the configured generations and reports free space", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ao-backup-loop-test-"));
  const source = join(directory, "source.sqlite");
  const destinationDirectory = join(directory, "generations");
  const database = createDatabase(source);
  try {
    const store = createStore(database);
    store.createProject({ slug: "retention", name: "Retention" });
    store.createWork("retention", { slug: "work", title: "Work" });
    let lastReport;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const result = await execFileAsync(
        process.execPath,
        [
          resolve("scripts/backup-loop.mjs"),
          "--once",
          "--source",
          source,
          "--destination-dir",
          destinationDirectory,
          "--keep",
          "2",
        ],
        { cwd: resolve(".") },
      );
      lastReport = JSON.parse(result.stdout);
    }
    const generations = readdirSync(destinationDirectory).filter((name) =>
      name.endsWith(".sqlite"),
    );
    assert.equal(generations.length, 2);
    assert.equal(lastReport.event, "backup_ok");
    assert.equal(lastReport.retained_generations, 2);
    assert.equal(lastReport.pruned_generations.length, 1);
    assert.equal(
      typeof lastReport.backup.source_storage.available_bytes,
      "number",
    );
    assert.equal(typeof lastReport.source_low_space, "boolean");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("required NFS failure leaves the service database alone and still reports its free space", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ao-backup-nfs-guard-test-"));
  if (storageUsage(directory).filesystem_type === NFS_SUPER_MAGIC) {
    rmSync(directory, { recursive: true, force: true });
    context.skip("temporary directory is already NFS");
    return;
  }
  const source = join(directory, "source.sqlite");
  const destinationDirectory = join(directory, "generations");
  const database = createDatabase(source);
  try {
    const store = createStore(database);
    store.createProject({ slug: "nfs-guard", name: "NFS guard" });
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          resolve("scripts/backup-loop.mjs"),
          "--once",
          "--require-nfs",
          "--source",
          source,
          "--destination-dir",
          destinationDirectory,
        ],
        { cwd: resolve(".") },
      ),
      (error) => {
        assert.equal(error.code, 1);
        const report = JSON.parse(error.stderr);
        assert.equal(report.event, "backup_failed");
        assert.match(report.error, /destination is not NFS/);
        assert.ok(report.source_storage.available_bytes > 0);
        assert.equal(typeof report.source_low_space, "boolean");
        assert.equal(existsSync(destinationDirectory), false);
        return true;
      },
    );
    assert.equal(store.getProject("nfs-guard").slug, "nfs-guard");
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
