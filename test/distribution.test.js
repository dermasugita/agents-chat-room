import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
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

test("CLI installer copies the complete runtime and smoke-tests rooms and join", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ao-cli-installer-test-"));
  const destination = join(directory, "stable-cli");
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        resolve("scripts/install-cli.mjs"),
        "--destination",
        destination,
      ],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          HOME: join(directory, "home"),
        },
      },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.installed, destination);
    assert.equal(result.shim, join(directory, "home", ".local", "bin", "ao"));
    assert.equal(existsSync(result.shim), true);
    assert.notEqual(statSync(result.shim).mode & 0o111, 0);
    assert.equal(realpathSync(result.shim), realpathSync(join(destination, "bin", "ao.js")));
    const shimVersion = await execFileAsync(result.shim, ["version"], {
      cwd: directory,
      env: { ...process.env, HOME: join(directory, "home") },
    });
    assert.equal(
      shimVersion.stdout.trim(),
      JSON.parse(readFileSync(resolve("package.json"), "utf8")).version,
    );
    assert.equal(result.smoke.rooms, 1);
    assert.equal(result.smoke.joined, "install-smoke/join-check");
    assert.equal(
      realpathSync(result.smoke.cli_path),
      realpathSync(join(destination, "bin", "ao.js")),
    );
    assert.match(relative(resolve("."), result.smoke.cli_path), /^\.\./);
    for (const path of [
      "bin/ao.js",
      "src/cli.js",
      "src/version.js",
      "CHANGELOG.md",
      "templates/skills/session-chat/SKILL.md",
      "templates/skills/session-chat/scripts/join-room.mjs",
      "templates/skills/session-chat/scripts/codex-implementer-monitor.sh",
    ]) {
      assert.equal(existsSync(join(destination, path)), true, path);
    }
    assert.equal(
      readFileSync(
        join(destination, "templates/skills/session-chat/SKILL.md"),
        "utf8",
      ),
      readFileSync(
        resolve("templates/skills/session-chat/SKILL.md"),
        "utf8",
      ),
    );
    assert.deepEqual(
      readdirSync(directory).filter(
        (name) =>
          name.includes(".installing-") ||
          name.includes(".previous-"),
      ),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  printf '%s\\n' '[{"State":{"Running":true},"Config":{"Env":["AO_DATABASE_PATH=/data/ao.sqlite"]}}]'
  exit 0
fi
if [ "$1" = "build" ]; then
  if [ -n "$FAKE_DOCKER_BUILD_WRITE_SCRIPT" ]; then
    "$FAKE_DOCKER_NODE" "$FAKE_DOCKER_BUILD_WRITE_SCRIPT" "$FAKE_DOCKER_SNAPSHOT" || exit $?
  fi
  touch "$FAKE_DOCKER_BUILD_MARKER"
  exit 0
fi
if [ "$1" = "stop" ]; then
  if [ "$FAKE_DOCKER_REQUIRE_BUILD" = "1" ] && [ ! -f "$FAKE_DOCKER_BUILD_MARKER" ]; then
    printf '%s\\n' 'server stopped before build completed' >&2
    exit 91
  fi
  touch "$FAKE_DOCKER_STOP_MARKER"
  exit 0
fi
if [ "$1" = "run" ]; then
  case " $* " in
    *" --name $FAKE_DOCKER_MIGRATION_NAME "*)
      if [ ! -f "$FAKE_DOCKER_STOP_MARKER" ]; then
        printf '%s\\n' 'migration ran before writes stopped' >&2
        exit 92
      fi
      "$FAKE_DOCKER_NODE" "$FAKE_DOCKER_MIGRATE_SCRIPT" "$FAKE_DOCKER_SNAPSHOT" "$FAKE_DOCKER_DESTINATION" || exit $?
      if [ -n "$FAKE_DOCKER_TAMPER_SCRIPT" ]; then
        "$FAKE_DOCKER_NODE" "$FAKE_DOCKER_TAMPER_SCRIPT" "$FAKE_DOCKER_DESTINATION" || exit $?
      fi
      exit 0
      ;;
  esac
fi
if [ "$1" = "start" ]; then
  touch "$FAKE_DOCKER_RESTART_MARKER"
  exit 0
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

test("first bind migration includes build-time writes after stopping the old server", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ao-deploy-migration-test-"));
  const legacySnapshot = join(directory, "legacy.sqlite");
  const stateDirectory = join(directory, "persistent-state");
  const buildMarker = join(directory, "build-complete");
  const stopMarker = join(directory, "writes-stopped");
  const restartMarker = join(directory, "old-restarted");
  const dockerLog = join(directory, "docker.log");
  const buildWriteScript = join(directory, "build-write.mjs");
  writeFileSync(
    buildWriteScript,
    `import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[2]);
database.prepare("INSERT INTO project(slug, name, created_at) VALUES (?, ?, ?)").run(
  "during-build",
  "Accepted during build",
  "2026-07-26T00:00:00.000Z",
);
const project = database.prepare("SELECT id FROM project WHERE slug = ?").get("during-build");
database.prepare("INSERT INTO work(project_id, slug, title, state, created_at) VALUES (?, ?, ?, 'open', ?)").run(
  project.id,
  "preserved",
  "Preserved build-time write",
  "2026-07-26T00:00:00.000Z",
);
database.close();
`,
    "utf8",
  );
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
        "--name",
        "migration-probe",
        "--state-dir",
        stateDirectory,
      ],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          FAKE_DOCKER_BUILD_MARKER: buildMarker,
          FAKE_DOCKER_BUILD_WRITE_SCRIPT: buildWriteScript,
          FAKE_DOCKER_DESTINATION: join(
            stateDirectory,
            "ao.sqlite.migration",
          ),
          FAKE_DOCKER_LOG: dockerLog,
          FAKE_DOCKER_MIGRATE_SCRIPT: resolve("scripts/migrate-db.mjs"),
          FAKE_DOCKER_MIGRATION_NAME: "migration-probe-migration",
          FAKE_DOCKER_NODE: process.execPath,
          FAKE_DOCKER_REQUIRE_BUILD: "1",
          FAKE_DOCKER_RESTART_MARKER: restartMarker,
          FAKE_DOCKER_SNAPSHOT: legacySnapshot,
          FAKE_DOCKER_STOP_MARKER: stopMarker,
          PATH: `${bin}:${process.env.PATH}`,
        },
      },
    );
    const output = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const buildIndex = output.findIndex(
      (item) => Array.isArray(item) && item[1] === "build",
    );
    const stopIndex = output.findIndex(
      (item) => Array.isArray(item) && item[1] === "stop",
    );
    const migrationIndex = output.findIndex(
      (item) =>
        Array.isArray(item) &&
        item[1] === "run" &&
        item.includes("migration-probe-migration"),
    );
    assert.ok(buildIndex >= 0);
    assert.ok(stopIndex > buildIndex);
    assert.ok(migrationIndex > stopIndex);
    const migration = output.find(
      (item) => item.event === "migrated_existing_database",
    );
    assert.equal(migration.writes_stopped, true);
    assert.equal(migration.counts_match, true);
    assert.equal(migration.content_rows, 4);
    assert.equal(existsSync(legacySnapshot), true);
    assert.equal(existsSync(buildMarker), true);
    assert.equal(existsSync(stopMarker), true);
    assert.equal(existsSync(restartMarker), false);
    const migratedPath = join(stateDirectory, "ao.sqlite");
    assert.equal(existsSync(migratedPath), true);
    const migrated = new DatabaseSync(migratedPath, { readOnly: true });
    try {
      assert.equal(
        migrated.prepare("SELECT COUNT(*) AS count FROM project").get().count,
        2,
      );
      assert.equal(
        migrated.prepare("SELECT COUNT(*) AS count FROM work").get().count,
        2,
      );
      assert.equal(
        migrated
          .prepare("SELECT COUNT(*) AS count FROM project WHERE slug = 'during-build'")
          .get().count,
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

test("deploy refuses a count mismatch, starts no replacement, and restarts the old server", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ao-deploy-mismatch-test-"));
  const legacySnapshot = join(directory, "legacy.sqlite");
  const stateDirectory = join(directory, "persistent-state");
  const buildMarker = join(directory, "build-complete");
  const stopMarker = join(directory, "writes-stopped");
  const restartMarker = join(directory, "old-restarted");
  const dockerLog = join(directory, "docker.log");
  const tamperScript = join(directory, "tamper.mjs");
  writeFileSync(
    tamperScript,
    `import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[2]);
database.prepare("INSERT INTO project(slug, name, created_at) VALUES (?, ?, ?)").run(
  "count-mismatch",
  "Count mismatch",
  "2026-07-26T00:00:00.000Z",
);
database.close();
`,
    "utf8",
  );
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
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          resolve("scripts/deploy.mjs"),
          "--name",
          "mismatch-probe",
          "--state-dir",
          stateDirectory,
        ],
        {
          cwd: resolve("."),
          env: {
            ...process.env,
            FAKE_DOCKER_BUILD_MARKER: buildMarker,
            FAKE_DOCKER_DESTINATION: join(
              stateDirectory,
              "ao.sqlite.migration",
            ),
            FAKE_DOCKER_LOG: dockerLog,
            FAKE_DOCKER_MIGRATE_SCRIPT: resolve("scripts/migrate-db.mjs"),
            FAKE_DOCKER_MIGRATION_NAME: "mismatch-probe-migration",
            FAKE_DOCKER_NODE: process.execPath,
            FAKE_DOCKER_REQUIRE_BUILD: "1",
            FAKE_DOCKER_RESTART_MARKER: restartMarker,
            FAKE_DOCKER_SNAPSHOT: legacySnapshot,
            FAKE_DOCKER_STOP_MARKER: stopMarker,
            FAKE_DOCKER_TAMPER_SCRIPT: tamperScript,
            PATH: `${bin}:${process.env.PATH}`,
          },
        },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /table counts do not match the stopped source/);
        return true;
      },
    );
    assert.equal(existsSync(join(stateDirectory, "ao.sqlite")), false);
    assert.equal(existsSync(join(stateDirectory, "ao.sqlite.migration")), false);
    assert.equal(existsSync(restartMarker), true);
    const commands = readFileSync(dockerLog, "utf8").trim().split("\n");
    assert.equal(
      commands.some((line) =>
        line.includes("run --detach --name mismatch-probe --restart"),
      ),
      false,
    );
    assert.equal(
      commands.some((line) => line === "start mismatch-probe"),
      true,
    );
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
