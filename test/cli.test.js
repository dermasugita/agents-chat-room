import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { createDatabase } from "../src/db.js";
import { createHttpServer } from "../src/server.js";
import { createStore } from "../src/store.js";
import { cliInternals } from "../src/cli.js";

const execFileAsync = promisify(execFile);
const cliPath = resolve("bin/ao.js");
let temporaryDirectory;
let database;
let store;
let application;
let serverUrl;
let isolatedHome;

before(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "ao-cli-test-"));
  isolatedHome = join(temporaryDirectory, "isolated-home");
  mkdirSync(isolatedHome, { recursive: true });
  database = createDatabase(join(temporaryDirectory, "server.sqlite"));
  store = createStore(database);
  store.createProject({ slug: "sample", name: "Sample" });
  store.createWork("sample", { slug: "work-one", title: "Work one" });
  store.createDocument("sample", {
    kind: "context",
    title: "Context",
    body: "# Terms\n\nInitial body.\n",
    author: "designer",
  });
  application = createHttpServer({ database, store });
  await new Promise((resolveListen) =>
    application.server.listen(0, "127.0.0.1", resolveListen),
  );
  serverUrl = `http://127.0.0.1:${application.server.address().port}`;
});

after(async () => {
  await new Promise((resolveClose) => application.server.close(resolveClose));
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function runCli(args, cwd, env = {}) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        AO_IDENTIFIER: "",
        AO_ROLE: "",
        AO_SERVER_URL: "",
        HOME: isolatedHome,
        ...env,
      },
      maxBuffer: 5 * 1024 * 1024,
    });
    return { ...result, code: 0 };
  } catch (error) {
    return {
      code: error.code,
      stderr: error.stderr,
      stdout: error.stdout,
    };
  }
}

async function runPersistentCli(args, cwd, timeout = 250) {
  try {
    await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        AO_IDENTIFIER: "",
        AO_ROLE: "",
        AO_SERVER_URL: "",
        HOME: isolatedHome,
      },
      maxBuffer: 5 * 1024 * 1024,
      timeout,
    });
    assert.fail("persistent CLI unexpectedly exited");
  } catch (error) {
    assert.equal(error.killed, true, error.stderr);
  }
}

async function runNodeScript(script, args, cwd, env = {}) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      cwd,
      env: {
        ...process.env,
        AO_IDENTIFIER: "",
        AO_ROLE: "",
        AO_SERVER_URL: "",
        HOME: isolatedHome,
        ...env,
      },
      maxBuffer: 5 * 1024 * 1024,
    });
    return { ...result, code: 0 };
  } catch (error) {
    return {
      code: error.code,
      killed: error.killed,
      stderr: error.stderr,
      stdout: error.stdout,
    };
  }
}

async function runTimedNodeScript(script, args, cwd, env = {}, timeout = 250) {
  try {
    await execFileAsync(process.execPath, [script, ...args], {
      cwd,
      env: {
        ...process.env,
        AO_IDENTIFIER: "",
        AO_ROLE: "",
        AO_SERVER_URL: "",
        HOME: isolatedHome,
        ...env,
      },
      maxBuffer: 5 * 1024 * 1024,
      timeout,
    });
    assert.fail("persistent script unexpectedly exited");
  } catch (error) {
    assert.equal(error.killed, true, error.stderr);
    return {
      stderr: error.stderr ?? "",
      stdout: error.stdout ?? "",
    };
  }
}

function heartbeatFor(identifier) {
  return store
    .getWork("sample", "work-one")
    .participants.find((participant) => participant.identifier === identifier)
    ?.last_heartbeat_at;
}

async function waitForClockTick() {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
}

function makeRepository(name) {
  const path = join(temporaryDirectory, name);
  mkdirSync(path, { recursive: true });
  return path;
}

async function injectRepository(repository, identifier) {
  const result = await runCli(
    [
      "inject",
      repository,
      "--server",
      serverUrl,
      "--project",
      "sample",
      "--identifier",
      identifier,
      "--role",
      "implementer",
      "--work",
      "work-one",
    ],
    temporaryDirectory,
  );
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("inject installs config, copies, runtime-neutral skills, pointers, and ignore rule", async () => {
  const repository = makeRepository("injected");
  writeFileSync(join(repository, "README.md"), "# target\n", "utf8");
  const result = await injectRepository(repository, "impl-a");
  assert.equal(result.project, "sample");
  assert.equal(result.documents, 1);
  const config = JSON.parse(
    readFileSync(join(repository, ".ao/config.json"), "utf8"),
  );
  assert.deepEqual(config.cli, {
    command: process.execPath,
    args: [cliPath],
  });

  for (const path of [
    ".ao/config.json",
    ".ao/docs/CONTEXT.md",
    ".claude/skills/session-chat/SKILL.md",
    ".agents/skills/session-chat/SKILL.md",
    ".claude/skills/session-chat/scripts/post-safe.mjs",
    ".agents/skills/session-chat/scripts/post-safe.mjs",
    ".claude/skills/session-chat/scripts/watch-passive.mjs",
    ".agents/skills/session-chat/scripts/watch-passive.mjs",
    ".claude/skills/session-chat/scripts/self-driven-loop.mjs",
    ".agents/skills/session-chat/scripts/self-driven-loop.mjs",
    ".claude/skills/session-chat/scripts/ball-check.mjs",
    ".agents/skills/session-chat/scripts/ball-check.mjs",
    ".claude/skills/session-chat/scripts/join-room.mjs",
    ".agents/skills/session-chat/scripts/join-room.mjs",
    ".claude/skills/session-chat/scripts/lib/ao-cli.mjs",
    ".agents/skills/session-chat/scripts/lib/ao-cli.mjs",
    ".claude/skills/design-handoff/scripts/designer-start.mjs",
    ".agents/skills/design-handoff/scripts/designer-start.mjs",
    "CLAUDE.md",
    "AGENTS.md",
  ]) {
    assert.equal(existsSync(join(repository, path)), true, path);
  }
  assert.equal(
    readFileSync(
      join(repository, ".claude/skills/session-chat/SKILL.md"),
      "utf8",
    ),
    readFileSync(
      join(repository, ".agents/skills/session-chat/SKILL.md"),
      "utf8",
    ),
  );
  for (const script of [
    "post-safe.mjs",
    "watch-passive.mjs",
    "self-driven-loop.mjs",
    "ball-check.mjs",
    "join-room.mjs",
  ]) {
    const claude = join(
      repository,
      ".claude/skills/session-chat/scripts",
      script,
    );
    const agents = join(
      repository,
      ".agents/skills/session-chat/scripts",
      script,
    );
    assert.equal(readFileSync(claude, "utf8"), readFileSync(agents, "utf8"));
    assert.notEqual(statSync(claude).mode & 0o111, 0, script);
    assert.notEqual(statSync(agents).mode & 0o111, 0, script);
  }
  const claudeHelper = join(
    repository,
    ".claude/skills/session-chat/scripts/lib/ao-cli.mjs",
  );
  const agentsHelper = join(
    repository,
    ".agents/skills/session-chat/scripts/lib/ao-cli.mjs",
  );
  assert.equal(
    readFileSync(claudeHelper, "utf8"),
    readFileSync(agentsHelper, "utf8"),
  );
  for (const path of [
    ".claude/skills/design-handoff/scripts/designer-start.mjs",
    ".agents/skills/design-handoff/scripts/designer-start.mjs",
  ]) {
    assert.notEqual(statSync(join(repository, path)).mode & 0o111, 0, path);
  }
  assert.match(readFileSync(join(repository, ".gitignore"), "utf8"), /^\/\.ao\/$/m);
  assert.match(
    readFileSync(join(repository, ".ao/docs/CONTEXT.md"), "utf8"),
    /revision=1 \/ doc=context/,
  );

  const skill = join(repository, ".agents/skills/session-chat/SKILL.md");
  writeFileSync(skill, "owner customization\n", "utf8");
  const reinject = await injectRepository(repository, "impl-a");
  assert.ok(
    reinject.skills.some(
      ({ action, target }) =>
        action === "backed-up" && target.endsWith(".agents/skills/session-chat/SKILL.md"),
    ),
  );
  assert.equal(existsSync(`${skill}.bak`), true);
  for (const pointer of ["CLAUDE.md", "AGENTS.md"]) {
    const content = readFileSync(join(repository, pointer), "utf8");
    assert.equal(
      content.match(/agents-chat-room:instructions:start/g)?.length,
      1,
    );
  }
});

test("inject creates or reuses --work and the repository is immediately usable", async () => {
  const repository = makeRepository("inject-work");
  const injectArgs = [
    "inject",
    repository,
    "--server",
    serverUrl,
    "--project",
    "inject-work-project",
    "--identifier",
    "inject-worker",
    "--role",
    "implementer",
    "--work",
    "implementation",
    "--work-title",
    "Implementation title",
  ];

  const first = await runCli(injectArgs, temporaryDirectory);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).work.title, "Implementation title");
  assert.deepEqual(
    store.getProject("inject-work-project").works.map(({ slug, title }) => ({
      slug,
      title,
    })),
    [{ slug: "implementation", title: "Implementation title" }],
  );

  const second = await runCli(
    [
      ...injectArgs.slice(0, -1),
      "A replacement title must not overwrite an existing work",
    ],
    temporaryDirectory,
  );
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).work.title, "Implementation title");
  assert.equal(store.getProject("inject-work-project").works.length, 1);

  const posted = await runCli(
    ["post", "--type", "message", "--body", "usable immediately"],
    repository,
  );
  assert.equal(posted.code, 0, posted.stderr);

  const watched = await runCli(["watch", "--once"], repository);
  assert.equal(watched.code, 0, watched.stderr);
  assert.match(
    watched.stdout,
    /MESSAGE seq=1 type=message from=inject-worker .*body="usable immediately"/,
  );
});

test("server resolution is environment, repository config, then user default", () => {
  const repository = makeRepository("server-resolution-repository");
  const unconfiguredRepository = makeRepository(
    "server-resolution-unconfigured-repository",
  );
  const homeDirectory = makeRepository("server-resolution-home");
  mkdirSync(join(repository, ".ao"), { recursive: true });
  mkdirSync(join(homeDirectory, ".ao"), { recursive: true });
  writeFileSync(
    join(repository, ".ao/config.json"),
    JSON.stringify({ server_url: "http://repository.example" }),
    "utf8",
  );
  writeFileSync(
    join(homeDirectory, ".ao/config.json"),
    JSON.stringify({ server_url: "http://user.example" }),
    "utf8",
  );
  const parsed = cliInternals.parseArguments(["rooms", "--repo", repository]);

  assert.deepEqual(
    cliInternals.resolveServerUrl(parsed, {
      environment: { AO_SERVER_URL: "http://environment.example" },
      homeDirectory,
    }),
    {
      server_url: "http://environment.example",
      source: "AO_SERVER_URL",
    },
  );
  assert.equal(
    cliInternals.resolveServerUrl(parsed, {
      environment: {},
      homeDirectory,
    }).server_url,
    "http://repository.example",
  );
  const unconfigured = cliInternals.parseArguments([
    "rooms",
    "--repo",
    unconfiguredRepository,
  ]);
  assert.equal(
    cliInternals.resolveServerUrl(unconfigured, {
      environment: {},
      homeDirectory,
    }).server_url,
    "http://user.example",
  );
});

test("identity resolution is flags, environment, then repository config", () => {
  const repositoryConfig = {
    identifier: "repository-agent",
    role: "implementer",
  };
  const fromRepository = cliInternals.resolveIdentity(
    cliInternals.parseArguments(["watch"]),
    repositoryConfig,
    { environment: {} },
  );
  assert.equal(fromRepository.identifier, "repository-agent");
  assert.equal(fromRepository.role, "implementer");

  const fromEnvironment = cliInternals.resolveIdentity(
    cliInternals.parseArguments(["watch"]),
    repositoryConfig,
    {
      environment: {
        AO_IDENTIFIER: "environment-agent",
        AO_ROLE: "designer",
      },
    },
  );
  assert.equal(fromEnvironment.identifier, "environment-agent");
  assert.equal(fromEnvironment.role, "designer");

  const fromFlags = cliInternals.resolveIdentity(
    cliInternals.parseArguments([
      "watch",
      "--identifier",
      "explicit-agent",
      "--role",
      "owner",
    ]),
    repositoryConfig,
    {
      environment: {
        AO_IDENTIFIER: "environment-agent",
        AO_ROLE: "designer",
      },
    },
  );
  assert.equal(fromFlags.identifier, "explicit-agent");
  assert.equal(fromFlags.role, "owner");
});

test("configure writes the one-time user server setting", async () => {
  const homeDirectory = makeRepository("configured-user-home");
  const result = await runCli(
    ["configure", "--server", serverUrl],
    temporaryDirectory,
    { HOME: homeDirectory },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(join(homeDirectory, ".ao/config.json"), "utf8")),
    { server_url: serverUrl },
  );
});

test("user config identity is warned, ignored, and removed by configure", async () => {
  const homeDirectory = makeRepository("configured-user-identity-home");
  mkdirSync(join(homeDirectory, ".ao"), { recursive: true });
  writeFileSync(
    join(homeDirectory, ".ao/config.json"),
    `${JSON.stringify(
      {
        server_url: "http://127.0.0.1:1",
        identifier: "unsafe-user-default",
        role: "designer",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const result = await runCli(
    ["configure", "--server", serverUrl],
    temporaryDirectory,
    { HOME: homeDirectory },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /ignoring and removing agent identity/);
  assert.match(result.stderr, /unsafe-user-default/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(homeDirectory, ".ao/config.json"), "utf8")),
    { server_url: serverUrl },
  );
});

test("every command rejects options it does not apply", async () => {
  for (const command of [
    "configure",
    "projects",
    "design",
    "rooms",
    "join",
    "inject",
    "delete-project",
    "delete-work",
    "delete-participant",
    "pull",
    "push",
    "post",
    "messages",
    "watch",
    "close",
    "resolve",
    "create-work",
    "create-document",
    "import",
  ]) {
    const result = await runCli(
      [command, "--definitely-unsupported"],
      temporaryDirectory,
    );
    assert.equal(result.code, 1, `${command}: ${result.stderr}`);
    assert.match(
      result.stderr,
      new RegExp(`Unknown option --definitely-unsupported for ao ${command}`),
      command,
    );
  }

  const configure = await runCli(
    ["configure", "--server", serverUrl, "--identifier", "silently-ignored"],
    temporaryDirectory,
  );
  assert.equal(configure.code, 1);
  assert.match(configure.stderr, /Unknown option --identifier for ao configure/);
});

test("repository config overrides a conflicting user default in real CLI commands", async () => {
  const repository = makeRepository("repository-server-priority");
  await injectRepository(repository, "repository-priority-agent");
  const conflictingHome = makeRepository("conflicting-user-default");
  mkdirSync(join(conflictingHome, ".ao"), { recursive: true });
  writeFileSync(
    join(conflictingHome, ".ao/config.json"),
    `${JSON.stringify({ server_url: "http://127.0.0.1:1" }, null, 2)}\n`,
    "utf8",
  );

  const result = await runCli(["watch", "--once"], repository, {
    AO_SERVER_URL: "",
    HOME: conflictingHome,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(heartbeatFor("repository-priority-agent"), /^2026-/);
});

test("two agents share one repository without mixing names or leaving answered questions abandoned", async () => {
  store.createProject({ slug: "shared-identity", name: "Shared identity" });
  store.createWork("shared-identity", {
    slug: "shared-work",
    title: "Shared work",
  });
  const repository = makeRepository("shared-identity-repository");
  mkdirSync(join(repository, ".ao"), { recursive: true });
  const repositoryConfig = {
    server_url: serverUrl,
    project: "shared-identity",
    work: "shared-work",
    identifier: "repository-default",
    role: "implementer",
    cli: {
      command: process.execPath,
      args: [cliPath],
    },
  };
  writeFileSync(
    join(repository, ".ao/config.json"),
    `${JSON.stringify(repositoryConfig, null, 2)}\n`,
    "utf8",
  );

  const implementerEnvironment = {
    AO_IDENTIFIER: "shared-implementer",
    AO_ROLE: "implementer",
  };
  const designerEnvironment = {
    AO_IDENTIFIER: "shared-designer",
    AO_ROLE: "designer",
  };
  const question = await runCli(
    [
      "post",
      "--type",
      "question",
      "--to",
      "shared-designer",
      "--body",
      "Does the shared identity stay distinct?",
    ],
    repository,
    implementerEnvironment,
  );
  assert.equal(question.code, 0, question.stderr);
  const questionSeq = JSON.parse(question.stdout).seq;

  const designerJoin = await runCli(
    ["watch", "--once"],
    repository,
    designerEnvironment,
  );
  assert.equal(designerJoin.code, 0, designerJoin.stderr);
  database
    .prepare(
      `UPDATE participant
          SET last_heartbeat_at = ?
        WHERE identifier = ?
          AND work_id = (
            SELECT work.id
              FROM work
              JOIN project ON project.id = work.project_id
             WHERE project.slug = ? AND work.slug = ?
          )`,
    )
    .run(
      "2020-01-01T00:00:00.000Z",
      "shared-designer",
      "shared-identity",
      "shared-work",
    );

  const beforeAnswer = await runCli(
    ["watch", "--once"],
    repository,
    implementerEnvironment,
  );
  assert.equal(beforeAnswer.code, 0, beforeAnswer.stderr);
  assert.match(beforeAnswer.stdout, /ABANDONED identifier=shared-designer/);

  const answer = await runCli(
    [
      "post",
      "--type",
      "answer",
      "--reply-to",
      String(questionSeq),
      "--body",
      "Yes. The designer answers under the designer identity.",
    ],
    repository,
    designerEnvironment,
  );
  assert.equal(answer.code, 0, answer.stderr);
  const afterAnswer = await runCli(
    ["watch", "--once"],
    repository,
    implementerEnvironment,
  );
  assert.equal(afterAnswer.code, 0, afterAnswer.stderr);
  assert.doesNotMatch(
    afterAnswer.stdout,
    /ABANDONED identifier=shared-designer/,
  );

  const explicit = await runCli(
    [
      "post",
      "--identifier",
      "explicit-agent",
      "--role",
      "implementer",
      "--type",
      "status",
      "--body",
      "Flags outrank the environment.",
    ],
    repository,
    designerEnvironment,
  );
  assert.equal(explicit.code, 0, explicit.stderr);

  const messages = store.listMessages("shared-identity", "shared-work");
  assert.deepEqual(
    messages.map(({ from }) => from),
    ["shared-implementer", "shared-designer", "explicit-agent"],
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(repository, ".ao/config.json"), "utf8")),
    repositoryConfig,
  );
});

test("all active thread and document commands accept explicit identity flags", async () => {
  store.createProject({ slug: "identity-flags", name: "Identity flags" });
  store.createWork("identity-flags", {
    slug: "flag-work",
    title: "Flag work",
  });
  store.createDocument("identity-flags", {
    kind: "context",
    title: "Flag context",
    body: "# Flag context\n",
    author: "designer",
  });
  const repository = makeRepository("identity-flags-repository");
  mkdirSync(join(repository, ".ao"), { recursive: true });
  writeFileSync(
    join(repository, ".ao/config.json"),
    `${JSON.stringify(
      {
        server_url: serverUrl,
        project: "identity-flags",
        work: "flag-work",
        identifier: "wrong-repository-default",
        role: "designer",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const identity = [
    "--identifier",
    "flag-agent",
    "--role",
    "implementer",
  ];

  for (const args of [
    ["messages", ...identity],
    ["watch", "--once", ...identity],
    ["pull", ...identity],
    ["push", "context", ...identity],
  ]) {
    const result = await runCli(args, repository);
    assert.equal(result.code, 0, `${args[0]}: ${result.stderr}`);
  }

  const status = await runCli(
    [
      "post",
      "--type",
      "status",
      "--body",
      "Every command accepts explicit identity.",
      ...identity,
    ],
    repository,
  );
  assert.equal(status.code, 0, status.stderr);
  const question = await runCli(
    [
      "post",
      "--type",
      "question",
      "--to",
      "reviewer",
      "--body",
      "Close this explicit-identity question.",
      ...identity,
    ],
    repository,
  );
  assert.equal(question.code, 0, question.stderr);
  const close = await runCli(
    ["close", String(JSON.parse(question.stdout).seq), ...identity],
    repository,
  );
  assert.equal(close.code, 0, close.stderr);
  const resolved = await runCli(["resolve", ...identity], repository);
  assert.equal(resolved.code, 0, resolved.stderr);

  const work = store.getWork("identity-flags", "flag-work");
  const participant = work.participants.find(
    ({ identifier }) => identifier === "flag-agent",
  );
  assert.equal(participant.role, "implementer");
  assert.match(participant.last_heartbeat_at, /^2026-/);
  assert.ok(
    store
      .listMessages("identity-flags", "flag-work")
      .every(({ from }) => from === "flag-agent"),
  );
});

test("delete CLI commands stay on the repository server and report protected cleanup", async () => {
  const repository = makeRepository("delete-cli-repository");
  await injectRepository(repository, "delete-cli-agent");
  const conflictingHome = makeRepository("delete-cli-conflicting-home");
  mkdirSync(join(conflictingHome, ".ao"), { recursive: true });
  writeFileSync(
    join(conflictingHome, ".ao/config.json"),
    `${JSON.stringify({ server_url: "http://127.0.0.1:1" }, null, 2)}\n`,
    "utf8",
  );
  store.createProject({ slug: "delete-cli", name: "Delete CLI" });
  store.createWork("delete-cli", { slug: "old-work", title: "Old work" });
  store.poll(
    "delete-cli",
    "old-work",
    "mistaken-agent",
    "implementer",
  );
  store.postMessage("delete-cli", "old-work", {
    idempotency_key: crypto.randomUUID(),
    from: "speaker",
    role: "implementer",
    type: "status",
    body: "keep attribution until the work is deleted",
    to: [],
    refs: [],
  });
  const environment = {
    AO_SERVER_URL: "",
    HOME: conflictingHome,
  };

  const participant = await runCli(
    [
      "delete-participant",
      "delete-cli",
      "old-work",
      "mistaken-agent",
    ],
    repository,
    environment,
  );
  assert.equal(participant.code, 0, participant.stderr);
  assert.equal(JSON.parse(participant.stdout).deleted.participants, 1);

  const protectedParticipant = await runCli(
    ["delete-participant", "delete-cli", "old-work", "speaker"],
    repository,
    environment,
  );
  assert.equal(protectedParticipant.code, 2);
  assert.match(protectedParticipant.stderr, /cannot be deleted after posting/i);

  const wrongConfirmation = await runCli(
    [
      "delete-work",
      "delete-cli",
      "old-work",
      "--confirm",
      "another-work",
    ],
    repository,
    environment,
  );
  assert.equal(wrongConfirmation.code, 1);
  assert.equal(store.getWork("delete-cli", "old-work").messages.length, 1);

  const work = await runCli(
    [
      "delete-work",
      "delete-cli",
      "old-work",
      "--confirm",
      "old-work",
    ],
    repository,
    environment,
  );
  assert.equal(work.code, 0, work.stderr);
  assert.deepEqual(JSON.parse(work.stdout).deleted, {
    projects: 0,
    works: 1,
    messages: 1,
    participants: 1,
    documents: 0,
    revisions: 0,
    message_recipients: 0,
    message_refs: 0,
    message_expectations: 0,
    ball_declarations: 0,
  });

  const project = await runCli(
    ["delete-project", "delete-cli", "--confirm", "delete-cli"],
    repository,
    environment,
  );
  assert.equal(project.code, 0, project.stderr);
  assert.equal(JSON.parse(project.stdout).deleted.projects, 1);
  assert.equal(
    store.listProjects().some(({ slug }) => slug === "delete-cli"),
    false,
  );
});

test("cold room join uses the declared slot, pulls context, and exposes the full thread", async () => {
  const controller = makeRepository("room-controller");
  await injectRepository(controller, "room-controller");
  const created = await runCli(
    [
      "create-work",
      "cold-room",
      "--title",
      "Cold room",
      "--implementer",
      "cold-implementer",
    ],
    controller,
  );
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(JSON.parse(created.stdout).expected_participant, {
    identifier: "cold-implementer",
    role: "implementer",
  });
  store.createDocument("sample", {
    kind: "handoff",
    slug: "cold-room",
    title: "Cold room handoff",
    body: "# Cold room handoff\n\nImplement this.\n",
    author: "designer",
  });
  store.createDocument("sample", {
    kind: "adr",
    title: "Cold join decision",
    body: "# Cold join decision\n\nUse the room slot.\n",
    author: "designer",
  });
  store.postMessage("sample", "cold-room", {
    idempotency_key: "cold-room-question",
    from: "designer",
    role: "designer",
    type: "question",
    body: "Confirm the first bounded unit",
    to: ["cold-implementer"],
    refs: [],
  });

  const userHome = makeRepository("cold-room-home");
  mkdirSync(join(userHome, ".ao"), { recursive: true });
  writeFileSync(
    join(userHome, ".ao/config.json"),
    `${JSON.stringify({ server_url: serverUrl }, null, 2)}\n`,
    "utf8",
  );
  const repository = makeRepository("cold-room-target");
  const environment = { AO_SERVER_URL: "", HOME: userHome };
  const listed = await runCli(["rooms", "--json"], repository, environment);
  assert.equal(listed.code, 0, listed.stderr);
  const rooms = JSON.parse(listed.stdout).rooms;
  const roomIndex = rooms.findIndex(
    (room) =>
      room.project.slug === "sample" && room.work.slug === "cold-room",
  );
  assert.notEqual(roomIndex, -1);
  assert.deepEqual(rooms[roomIndex].expected_participant, {
    identifier: "cold-implementer",
    role: "implementer",
  });
  assert.equal(rooms[roomIndex].presence.present, false);

  const helper = resolve(
    "templates/skills/session-chat/scripts/join-room.mjs",
  );
  const roomHelperEnvironment = {
    AO_CLI: cliPath,
    AO_SERVER_URL: "",
    HOME: userHome,
  };
  const helperListing = await runNodeScript(
    helper,
    [],
    repository,
    roomHelperEnvironment,
  );
  assert.equal(helperListing.code, 0, helperListing.stderr);
  assert.match(helperListing.stdout, /Available chat rooms:/);
  assert.match(helperListing.stdout, /slot=cold-implementer \(implementer\)/);
  assert.equal(
    existsSync(join(repository, ".ao/room-selection.json")),
    true,
  );

  const joined = await runNodeScript(
    helper,
    [String(roomIndex + 1), "--repo", repository],
    repository,
    roomHelperEnvironment,
  );
  assert.equal(joined.code, 0, joined.stderr);
  const bootstrap = JSON.parse(joined.stdout);
  assert.equal(bootstrap.config.identifier, "cold-implementer");
  assert.equal(bootstrap.config.role, "implementer");
  assert.equal(bootstrap.config.project, "sample");
  assert.equal(bootstrap.config.work, "cold-room");
  assert.equal(bootstrap.config.server_source, join(userHome, ".ao/config.json"));
  assert.equal(bootstrap.your_ball.has_ball, true);
  assert.ok(
    bootstrap.messages.some(
      ({ body, type }) =>
        type === "question" && body === "Confirm the first bounded unit",
    ),
  );
  for (const path of [
    ".ao/config.json",
    ".ao/docs/CONTEXT.md",
    ".ao/docs/handoff/cold-room.md",
    ".agents/skills/session-chat/SKILL.md",
    ".agents/skills/session-chat/scripts/join-room.mjs",
  ]) {
    assert.equal(existsSync(join(repository, path)), true, path);
  }

  const duplicateRepository = makeRepository("cold-room-duplicate");
  const duplicate = await runCli(
    ["join", String(roomIndex + 1), "--repo", duplicateRepository],
    duplicateRepository,
    environment,
  );
  assert.equal(duplicate.code, 2);
  assert.match(duplicate.stderr, /WARNING: cold-implementer is already present/);
  assert.match(duplicate.stderr, /--confirm-occupied/);

  const duplicateListing = await runNodeScript(
    helper,
    [],
    duplicateRepository,
    roomHelperEnvironment,
  );
  assert.equal(duplicateListing.code, 0, duplicateListing.stderr);
  const confirmed = await runNodeScript(
    helper,
    [String(roomIndex + 1), "--repo", duplicateRepository],
    duplicateRepository,
    roomHelperEnvironment,
  );
  assert.equal(confirmed.code, 0, confirmed.stderr);

  const activeLoop = await runCli(["watch", "--once"], repository, environment);
  assert.equal(activeLoop.code, 0, activeLoop.stderr);
  const started = await runCli(
    [
      "post",
      "--type",
      "status",
      "--body",
      "Joined through session-chat; starting the first bounded unit",
    ],
    repository,
    environment,
  );
  assert.equal(started.code, 0, started.stderr);
  assert.ok(
    store
      .listMessages("sample", "cold-room")
      .some(({ body }) => body.startsWith("Joined through session-chat")),
  );

  const compatibilityRepository = makeRepository("room-without-slot");
  const noSlot = await runCli(
    ["join", "sample/work-one", "--repo", compatibilityRepository],
    compatibilityRepository,
    environment,
  );
  assert.equal(noSlot.code, 2);
  assert.match(noSlot.stderr, /has no implementer slot/);
  assert.match(noSlot.stderr, /--identifier ID/);
});

test("join, inject, and design warn before replacing repository identity", async () => {
  function writeExistingConfig(repository, identifier, role = "implementer") {
    mkdirSync(join(repository, ".ao"), { recursive: true });
    writeFileSync(
      join(repository, ".ao/config.json"),
      `${JSON.stringify(
        {
          server_url: serverUrl,
          project: "sample",
          work: "work-one",
          identifier,
          role,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  const joinRepository = makeRepository("identity-warning-join");
  writeExistingConfig(joinRepository, "old-join-agent");
  const joined = await runCli(
    [
      "join",
      "sample/work-one",
      "--repo",
      joinRepository,
      "--identifier",
      "new-join-agent",
      "--role",
      "implementer",
    ],
    joinRepository,
  );
  assert.equal(joined.code, 0, joined.stderr);
  assert.match(joined.stderr, /WARNING: ao join will overwrite agent identity/);
  assert.match(
    joined.stderr,
    /identifier "old-join-agent" -> "new-join-agent"/,
  );

  const injectRepositoryPath = makeRepository("identity-warning-inject");
  writeExistingConfig(injectRepositoryPath, "old-inject-agent");
  const injected = await runCli(
    [
      "inject",
      injectRepositoryPath,
      "--server",
      serverUrl,
      "--project",
      "sample",
      "--work",
      "work-one",
      "--identifier",
      "new-inject-agent",
      "--role",
      "implementer",
    ],
    temporaryDirectory,
  );
  assert.equal(injected.code, 0, injected.stderr);
  assert.match(
    injected.stderr,
    /WARNING: ao inject will overwrite agent identity/,
  );

  const designRepository = makeRepository("identity-warning-design");
  writeExistingConfig(designRepository, "old-design-agent");
  const designed = await runCli(
    [
      "design",
      "sample",
      "--repo",
      designRepository,
      "--identifier",
      "new-designer",
      "--role",
      "designer",
      "--force",
    ],
    designRepository,
  );
  assert.equal(designed.code, 0, designed.stderr);
  assert.match(
    designed.stderr,
    /WARNING: ao design will overwrite agent identity/,
  );
  assert.match(
    designed.stderr,
    /role "implementer" -> "designer"/,
  );
});

test("designer cold start joins every work and creates missing projects for skeleton grilling", async () => {
  store.createProject({ slug: "design-project", name: "Design Project" });
  for (const [slug, title] of [
    ["active-work", "Active work"],
    ["question-work", "Question work"],
    ["idle-work", "Idle work"],
  ]) {
    store.createWork("design-project", { slug, title });
  }
  store.createDocument("design-project", {
    kind: "context",
    title: "Design context",
    body: "# Design context\n\nShared terms.\n",
    author: "designer",
  });
  store.createDocument("design-project", {
    kind: "adr",
    title: "Project decision",
    body: "# Project decision\n\nA decision.\n",
    author: "designer",
  });
  for (const slug of ["active-work", "question-work", "idle-work"]) {
    store.createDocument("design-project", {
      kind: "handoff",
      slug,
      title: `${slug} handoff`,
      body: `# ${slug} handoff\n\nRequirements.\n`,
      author: "designer",
    });
  }
  store.postMessage("design-project", "active-work", {
    idempotency_key: "design-active-implementer",
    from: "active-implementer",
    role: "implementer",
    type: "status",
    body: "Implementation started",
    to: [],
    refs: [],
  });
  store.postMessage("design-project", "active-work", {
    idempotency_key: "design-abandoned-ball",
    from: "designer",
    role: "designer",
    type: "status",
    body: "Continue implementation",
    to: [],
    refs: [],
    ball: ["active-implementer"],
  });
  database
    .prepare(
      `UPDATE participant
       SET last_heartbeat_at = '2026-07-25T00:00:00.000Z'
       WHERE identifier = 'active-implementer'
         AND work_id = (
           SELECT work.id FROM work
           JOIN project ON project.id = work.project_id
           WHERE project.slug = 'design-project' AND work.slug = 'active-work'
         )`,
    )
    .run();
  store.postMessage("design-project", "question-work", {
    idempotency_key: "design-question",
    from: "question-implementer",
    role: "implementer",
    type: "question",
    body: "Which invariant applies?",
    to: ["designer"],
    refs: [],
  });
  database
    .prepare(
      `UPDATE work
       SET created_at = '2026-07-25T00:00:00.000Z'
       WHERE slug = 'idle-work'
         AND project_id = (SELECT id FROM project WHERE slug = 'design-project')`,
    )
    .run();

  const userHome = makeRepository("designer-home");
  mkdirSync(join(userHome, ".ao"), { recursive: true });
  writeFileSync(
    join(userHome, ".ao/config.json"),
    `${JSON.stringify({ server_url: serverUrl }, null, 2)}\n`,
    "utf8",
  );
  const environment = {
    AO_CLI: cliPath,
    AO_SERVER_URL: "",
    HOME: userHome,
  };
  const helper = resolve(
    "templates/skills/design-handoff/scripts/designer-start.mjs",
  );
  const repository = makeRepository("designer-existing-project");
  const started = await runNodeScript(
    helper,
    ["design-project"],
    repository,
    environment,
  );
  assert.equal(started.code, 0, started.stderr);
  const bootstrap = JSON.parse(started.stdout);
  assert.equal(bootstrap.created, false);
  assert.deepEqual(bootstrap.project, {
    slug: "design-project",
    name: "Design Project",
  });
  assert.equal(bootstrap.config.identifier, "designer");
  assert.equal(bootstrap.config.role, "designer");
  assert.equal("work" in bootstrap.config, false);
  assert.equal(bootstrap.threads.length, 3);
  assert.equal(
    bootstrap.threads.find(({ work }) => work === "question-work").your_ball
      .has_ball,
    true,
  );
  assert.equal(
    bootstrap.threads.find(({ work }) => work === "active-work").abandoned[0]
      .identifier,
    "active-implementer",
  );
  assert.match(
    bootstrap.threads.find(({ work }) => work === "idle-work").idle_nudge,
    /5 minutes/,
  );
  for (const slug of ["active-work", "question-work", "idle-work"]) {
    const participant = store
      .getWork("design-project", slug)
      .participants.find(({ identifier }) => identifier === "designer");
    assert.equal(participant.role, "designer");
    assert.match(participant.last_heartbeat_at, /^2026-/);
  }
  for (const path of [
    ".ao/docs/CONTEXT.md",
    ".ao/docs/adr/0001-project-decision.md",
    ".ao/docs/handoff/active-work.md",
    ".ao/docs/handoff/question-work.md",
    ".ao/docs/handoff/idle-work.md",
    ".agents/skills/design-handoff/SKILL.md",
    ".agents/skills/design-handoff/scripts/designer-start.mjs",
  ]) {
    assert.equal(existsSync(join(repository, path)), true, path);
  }

  await waitForClockTick();
  store.postMessage("design-project", "active-work", {
    idempotency_key: "design-new-active",
    from: "active-implementer",
    role: "implementer",
    type: "status",
    body: "Active work changed on disk",
    to: [],
    refs: [],
  });
  store.postMessage("design-project", "question-work", {
    idempotency_key: "design-new-question",
    from: "question-implementer",
    role: "implementer",
    type: "status",
    body: "Question work changed on disk",
    to: [],
    refs: [],
  });
  const watched = await runCli(
    ["watch", "--project", "--once"],
    repository,
    { AO_SERVER_URL: "", HOME: userHome },
  );
  assert.equal(watched.code, 0, watched.stderr);
  assert.equal(
    watched.stdout.match(/^PROJECT_WORK /gm)?.length,
    3,
  );
  assert.match(
    watched.stdout,
    /WORK project=design-project work=active-work MESSAGE .*Active work changed on disk/,
  );
  assert.match(
    watched.stdout,
    /WORK project=design-project work=question-work MESSAGE .*Question work changed on disk/,
  );
  assert.doesNotMatch(watched.stdout, /Implementation started/);

  const listRepository = makeRepository("designer-project-list");
  const projects = await runNodeScript(
    helper,
    [],
    listRepository,
    environment,
  );
  assert.equal(projects.code, 0, projects.stderr);
  assert.match(projects.stdout, /Available projects:/);
  assert.match(projects.stdout, /design-project/);

  const newRepository = makeRepository("designer-new-project");
  const created = await runNodeScript(
    helper,
    ["Brand New Product"],
    newRepository,
    environment,
  );
  assert.equal(created.code, 0, created.stderr);
  const newBootstrap = JSON.parse(created.stdout);
  assert.equal(newBootstrap.created, true);
  assert.deepEqual(newBootstrap.project, {
    slug: "brand-new-product",
    name: "Brand New Product",
  });
  assert.equal(newBootstrap.skeleton_grill.required, true);
  assert.equal(newBootstrap.skeleton_grill.first_branches.length, 5);
  assert.equal(store.getProject("brand-new-product").works.length, 0);
  const emptyWatch = await runCli(
    ["watch", "--project", "--once"],
    newRepository,
    { AO_SERVER_URL: "", HOME: userHome },
  );
  assert.equal(emptyWatch.code, 0, emptyWatch.stderr);
  assert.match(
    emptyWatch.stdout,
    /PROJECT project=brand-new-product works=0 skeleton_grill=true/,
  );
});

test("editing a copy alone does not update the source and pull protects it", async () => {
  const repository = makeRepository("pull-protection");
  await injectRepository(repository, "impl-b");
  const copy = join(repository, ".ao/docs/CONTEXT.md");
  writeFileSync(
    copy,
    readFileSync(copy, "utf8").replace("Initial body.", "Unpushed body."),
    "utf8",
  );
  assert.equal(store.getDocument("sample", "context").revision, 1);
  assert.match(store.getDocument("sample", "context").body, /Initial body/);

  const pull = await runCli(["pull"], repository);
  assert.equal(pull.code, 2);
  assert.match(pull.stderr, /unpushed edits/);
  assert.match(readFileSync(copy, "utf8"), /Unpushed body/);

  const push = await runCli(["push", "context"], repository);
  assert.equal(push.code, 0, push.stderr);
  assert.equal(store.getDocument("sample", "context").revision, 2);
  assert.match(store.getDocument("sample", "context").body, /Unpushed body/);
});

test("a 409 refreshes the copy, preserves the rejected edit, and exits nonzero", async () => {
  const first = makeRepository("client-one");
  const second = makeRepository("client-two");
  await injectRepository(first, "impl-one");
  await injectRepository(second, "impl-two");
  const firstCopy = join(first, ".ao/docs/CONTEXT.md");
  const secondCopy = join(second, ".ao/docs/CONTEXT.md");
  writeFileSync(
    firstCopy,
    readFileSync(firstCopy, "utf8").replace("Unpushed body.", "Winner."),
    "utf8",
  );
  writeFileSync(
    secondCopy,
    readFileSync(secondCopy, "utf8").replace("Unpushed body.", "Rejected."),
    "utf8",
  );
  assert.equal((await runCli(["push", "context"], first)).code, 0);
  const conflict = await runCli(["push", "context"], second);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /Revision conflict/);
  assert.match(readFileSync(secondCopy, "utf8"), /Winner/);
  assert.equal(existsSync(`${secondCopy}.rejected`), true);
  assert.match(readFileSync(`${secondCopy}.rejected`, "utf8"), /Rejected/);
});

test("watch emits each message as one distinguishable line", async () => {
  const repository = makeRepository("watcher");
  await injectRepository(repository, "watcher");
  store.postMessage("sample", "work-one", {
    idempotency_key: crypto.randomUUID(),
    from: "designer",
    role: "designer",
    type: "message",
    body: "line one\nline two",
    to: ["watcher"],
    refs: [],
  });
  const result = await runCli(["watch", "--once"], repository);
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.ok(lines.some((line) => /^MESSAGE seq=\d+ type=message/.test(line)));
  const messageLine = lines.find((line) => line.startsWith("MESSAGE "));
  assert.match(messageLine, /line one\\nline two/);
});

test("active CLI commands refresh heartbeat while persistent watch does not", async () => {
  const repository = makeRepository("heartbeat-cli");
  await injectRepository(repository, "heartbeat-cli");

  const messages = await runCli(["messages"], repository);
  assert.equal(messages.code, 0, messages.stderr);
  const afterMessages = heartbeatFor("heartbeat-cli");
  assert.match(afterMessages, /^\d{4}-/);

  store.postMessage("sample", "work-one", {
    idempotency_key: crypto.randomUUID(),
    from: "designer",
    role: "designer",
    type: "question",
    body: "Keep the ball while the passive watcher runs",
    to: ["heartbeat-cli"],
    refs: [],
  });
  await waitForClockTick();
  await runPersistentCli(["watch", "--interval", "0.01"], repository);
  assert.equal(heartbeatFor("heartbeat-cli"), afterMessages);

  await waitForClockTick();
  const once = await runCli(["watch", "--once"], repository);
  assert.equal(once.code, 0, once.stderr);
  const afterOnce = heartbeatFor("heartbeat-cli");
  assert.ok(afterOnce > afterMessages);

  await waitForClockTick();
  const pulled = await runCli(["pull"], repository);
  assert.equal(pulled.code, 0, pulled.stderr);
  const afterPull = heartbeatFor("heartbeat-cli");
  assert.ok(afterPull > afterOnce);

  const copy = join(repository, ".ao/docs/CONTEXT.md");
  writeFileSync(
    copy,
    `${readFileSync(copy, "utf8")}\nHeartbeat push edit.\n`,
    "utf8",
  );
  await waitForClockTick();
  const pushed = await runCli(["push", "context"], repository);
  assert.equal(pushed.code, 0, pushed.stderr);
  const afterPush = heartbeatFor("heartbeat-cli");
  assert.ok(afterPush > afterPull);

  await waitForClockTick();
  const posted = await runCli(
    ["post", "--type", "status", "--body", "active post heartbeat"],
    repository,
  );
  assert.equal(posted.code, 0, posted.stderr);
  const afterPost = heartbeatFor("heartbeat-cli");
  assert.ok(afterPost > afterPush);

  await waitForClockTick();
  const question = await runCli(
    [
      "post",
      "--type",
      "question",
      "--to",
      "designer",
      "--body",
      "close heartbeat question",
    ],
    repository,
  );
  assert.equal(question.code, 0, question.stderr);
  const questionSeq = JSON.parse(question.stdout).seq;
  const afterQuestion = heartbeatFor("heartbeat-cli");

  await waitForClockTick();
  const closed = await runCli(["close", String(questionSeq)], repository);
  assert.equal(closed.code, 0, closed.stderr);
  const afterClose = heartbeatFor("heartbeat-cli");
  assert.ok(afterClose > afterQuestion);

  await waitForClockTick();
  const resolved = await runCli(["resolve"], repository);
  assert.equal(resolved.code, 0, resolved.stderr);
  assert.ok(heartbeatFor("heartbeat-cli") > afterClose);
});

test("injected built-in scripts validate, monitor Japanese, loop, and check ball", async () => {
  const repository = makeRepository("built-in-scripts");
  await injectRepository(repository, "built-in-agent");
  const scriptRoot = join(
    repository,
    ".agents/skills/session-chat/scripts",
  );
  const noAdditionalCliSetup = { AO_CLI: "", PATH: "" };

  const invalidAnswer = await runNodeScript(
    join(scriptRoot, "post-safe.mjs"),
    ["--type", "answer", "--body", "missing reply"],
    repository,
    { AO_CLI: "/path/that/must/not/be-started" },
  );
  assert.equal(invalidAnswer.code, 64);
  assert.match(invalidAnswer.stderr, /answer requires a positive --reply-to/);
  assert.match(invalidAnswer.stderr, /request was not sent/);

  const invalidQuestion = await runNodeScript(
    join(scriptRoot, "post-safe.mjs"),
    ["--type", "question", "--body", "missing recipient"],
    repository,
    { AO_CLI: "/path/that/must/not/be-started" },
  );
  assert.equal(invalidQuestion.code, 64);
  assert.match(invalidQuestion.stderr, /question requires at least one --to/);
  assert.match(invalidQuestion.stderr, /request was not sent/);

  const failingCli = join(repository, "failing-ao.mjs");
  writeFileSync(
    failingCli,
    'process.stderr.write("DOWNSTREAM_FAILURE\\n"); process.exit(23);\n',
    "utf8",
  );
  const downstreamFailure = await runNodeScript(
    join(scriptRoot, "post-safe.mjs"),
    ["--type", "status", "--body", "preserve the CLI exit code"],
    repository,
    { AO_CLI: failingCli },
  );
  assert.equal(downstreamFailure.code, 23);
  assert.match(downstreamFailure.stderr, /DOWNSTREAM_FAILURE/);

  const pathOnlyRepository = makeRepository("built-in-path-fallback");
  const pathBin = join(pathOnlyRepository, "bin");
  mkdirSync(pathBin, { recursive: true });
  const pathCli = join(pathBin, "ao");
  writeFileSync(
    pathCli,
    `#!${process.execPath}\nprocess.stdout.write("PATH_FALLBACK " + process.argv.slice(2).join(" ") + "\\n");\n`,
    "utf8",
  );
  chmodSync(pathCli, 0o755);
  const pathFallback = await runNodeScript(
    join(scriptRoot, "post-safe.mjs"),
    ["--type", "status", "--body", "use PATH last"],
    pathOnlyRepository,
    { AO_CLI: "", PATH: pathBin },
  );
  assert.equal(pathFallback.code, 0, pathFallback.stderr);
  assert.match(pathFallback.stdout, /^PATH_FALLBACK post --type status/);

  const posted = await runNodeScript(
    join(scriptRoot, "post-safe.mjs"),
    [
      "--type",
      "question",
      "--to",
      "designer",
      "--body",
      "日本語の投稿ラッパ確認",
    ],
    repository,
    noAdditionalCliSetup,
  );
  assert.equal(posted.code, 0, posted.stderr);
  assert.match(posted.stdout, /日本語の投稿ラッパ確認/);

  const since = store.listMessages("sample", "work-one").at(-1).seq;
  store.postMessage("sample", "work-one", {
    idempotency_key: crypto.randomUUID(),
    from: "designer",
    role: "designer",
    type: "message",
    body: "日本語の長文です。取得成功を新着ゼロや失敗と混同しません。".repeat(20),
    to: ["built-in-agent"],
    refs: [],
  });
  const monitored = await runTimedNodeScript(
    join(scriptRoot, "watch-passive.mjs"),
    ["--since", String(since), "--interval", "0.01"],
    repository,
    noAdditionalCliSetup,
  );
  assert.match(monitored.stdout, /MESSAGE .*日本語の長文です/);
  assert.doesNotMatch(monitored.stderr, /ERROR watch failure=/);

  const latest = store.listMessages("sample", "work-one").at(-1).seq;
  const empty = await runTimedNodeScript(
    join(scriptRoot, "watch-passive.mjs"),
    ["--since", String(latest), "--interval", "0.01"],
    repository,
    noAdditionalCliSetup,
    100,
  );
  assert.doesNotMatch(empty.stdout, /MESSAGE /);
  assert.doesNotMatch(empty.stderr, /ERROR watch failure=/);

  const failedRepository = makeRepository("built-in-watch-failure");
  mkdirSync(join(failedRepository, ".ao"), { recursive: true });
  writeFileSync(
    join(failedRepository, ".ao/config.json"),
    `${JSON.stringify({
      server_url: "http://127.0.0.1:1",
      project: "sample",
      identifier: "failure-agent",
      role: "implementer",
      work: "work-one",
      cli: {
        command: process.execPath,
        args: [cliPath],
      },
    })}\n`,
    "utf8",
  );
  const failed = await runTimedNodeScript(
    join(scriptRoot, "watch-passive.mjs"),
    ["--interval", "0.01"],
    failedRepository,
    noAdditionalCliSetup,
    150,
  );
  assert.match(failed.stderr, /ERROR watch failure=1/);
  assert.match(failed.stderr, /ERROR watch failure=2/);
  assert.doesNotMatch(failed.stdout, /MESSAGE /);

  store.postMessage("sample", "work-one", {
    idempotency_key: crypto.randomUUID(),
    from: "designer",
    role: "designer",
    type: "question",
    body: "Built-in agent has the ball",
    to: ["built-in-agent"],
    refs: [],
  });
  const ball = await runNodeScript(
    join(scriptRoot, "ball-check.mjs"),
    [],
    repository,
    noAdditionalCliSetup,
  );
  assert.equal(ball.code, 0, ball.stderr);
  assert.match(ball.stdout, /^BALL has_ball=true idle=false reasons=/);

  const loop = await runNodeScript(
    join(scriptRoot, "self-driven-loop.mjs"),
    ["--", process.execPath, "-e", "console.log('WORK_UNIT_OK')"],
    repository,
    noAdditionalCliSetup,
  );
  assert.equal(loop.code, 0, loop.stderr);
  assert.match(loop.stdout, /WORK_UNIT_OK/);
  assert.match(loop.stderr, /active thread check/);
  assert.match(loop.stderr, /cycle complete/);

  const unresolvedRepository = makeRepository("built-in-unresolved-cli");
  mkdirSync(join(unresolvedRepository, ".ao"), { recursive: true });
  writeFileSync(
    join(unresolvedRepository, ".ao/config.json"),
    `${JSON.stringify({
      server_url: serverUrl,
      project: "sample",
      identifier: "unresolved-agent",
      role: "implementer",
      work: "work-one",
    })}\n`,
    "utf8",
  );
  const unresolved = await runNodeScript(
    join(scriptRoot, "ball-check.mjs"),
    [],
    unresolvedRepository,
    { AO_CLI: "", PATH: "" },
  );
  assert.equal(unresolved.code, 1);
  assert.match(unresolved.stderr, /AO_CLI is not set/);
  assert.match(unresolved.stderr, /has no valid cli\.command and cli\.args/);
  assert.match(unresolved.stderr, /PATH contains no executable ao/);
  assert.doesNotMatch(unresolved.stderr, /ENOENT/);
});

test("HTTP 400 exits 1 and explains the server rejection", async () => {
  const repository = makeRepository("bad-request");
  await injectRepository(repository, "bad-requester");
  const result = await runCli(
    [
      "post",
      "--type",
      "question",
      "--body",
      "A question without a recipient",
    ],
    repository,
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Server returned 400/);
  assert.match(result.stderr, /question messages require at least one recipient/);
});

test("an owner web post appears in CLI watch output", async () => {
  const repository = makeRepository("owner-watch");
  await injectRepository(repository, "owner-watcher");
  const since = store.listMessages("sample", "work-one").at(-1)?.seq ?? 0;
  const posted = await fetch(
    `${serverUrl}/projects/sample/works/work-one/messages`,
    {
    method: "POST",
    body: new URLSearchParams({
      body: "Owner-originated input",
      to: "owner-watcher",
      type: "decision",
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    },
  );
  assert.equal(posted.status, 303);
  const result = await runCli(
    ["watch", "--once", "--since", String(since)],
    repository,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /type=decision from=owner/);
  assert.match(result.stdout, /Owner-originated input/);
});

test("import shows a plan, requires confirmation, and sends legacy files", async () => {
  const controller = makeRepository("import-controller");
  await injectRepository(controller, "importer");
  const source = makeRepository("legacy-source");
  mkdirSync(join(source, "docs", "adr"), { recursive: true });
  mkdirSync(join(source, "docs", "handoff"), { recursive: true });
  mkdirSync(join(source, "docs", "session"), { recursive: true });
  writeFileSync(join(source, "CONTEXT.md"), "# Legacy terms\n", "utf8");
  writeFileSync(
    join(source, "docs", "adr", "0003-keep-number.md"),
    "# Keep number\n",
    "utf8",
  );
  writeFileSync(
    join(source, "docs", "handoff", "legacy-work.md"),
    "# Legacy work\n",
    "utf8",
  );
  writeFileSync(
    join(source, "docs", "session", "legacy-work.jsonl"),
    [
      JSON.stringify({
        id: "msg-0001",
        ts: "2026-07-26T09:00:00+09:00",
        from: "designer",
        to: ["implementer"],
        type: "question",
        body: "legacy",
      }),
      JSON.stringify({
        id: "msg-0001",
        ts: "2026-07-26T09:00:01+09:00",
        from: "implementer",
        to: [],
        type: "message",
        body: "duplicate id retained",
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const preview = await runCli(
    ["import", source, "--project", "legacy-cli", "--name", "Legacy CLI"],
    controller,
  );
  assert.equal(preview.code, 2);
  assert.match(preview.stderr, /Import plan/);
  assert.match(preview.stderr, /repeat with --yes/);

  const imported = await runCli(
    [
      "import",
      source,
      "--project",
      "legacy-cli",
      "--name",
      "Legacy CLI",
      "--yes",
    ],
    controller,
  );
  assert.equal(imported.code, 0, imported.stderr);
  const result = JSON.parse(imported.stdout);
  assert.equal(result.documents, 3);
  assert.equal(result.messages, 2);
  assert.equal(store.getProject("legacy-cli").works.length, 1);
  const messages = store.listMessages("legacy-cli", "legacy-work");
  assert.equal(messages.length, 2);
  assert.ok(messages.every(({ refs }) => refs.includes("imported-id:msg-0001")));
});

test("import lists every invalid source line and preserves an empty destination", async () => {
  const controller = makeRepository("invalid-import-controller");
  await injectRepository(controller, "invalid-importer");
  const source = makeRepository("invalid-import-source");
  mkdirSync(join(source, "docs", "session"), { recursive: true });
  writeFileSync(
    join(source, "docs", "session", "first-work.jsonl"),
    [
      JSON.stringify({
        id: "msg-0001",
        ts: "bad-time-one",
        from: "designer",
        type: "message",
        body: "first",
      }),
      JSON.stringify({
        id: "msg-0002",
        ts: "2026-07-26T09:00:00+09:00",
        closed_at: "bad-time-two",
        from: "designer",
        type: "message",
        body: "second",
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  writeFileSync(
    join(source, "docs", "session", "second-work.jsonl"),
    `${JSON.stringify({
      id: "msg-0003",
      ts: "bad-time-three",
      from: "implementer",
      type: "status",
      body: "third",
    })}\n`,
    "utf8",
  );

  const invalid = await runCli(
    [
      "import",
      source,
      "--project",
      "invalid-cli-import",
      "--name",
      "Invalid CLI import",
      "--yes",
    ],
    controller,
  );
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Import validation failed for 3 source field/);
  for (const expected of [
    "first-work.jsonl:1 id=msg-0001 field=ts",
    "first-work.jsonl:2 id=msg-0002 field=closed_at",
    "second-work.jsonl:1 id=msg-0003 field=ts",
    'value="bad-time-one"',
    'value="bad-time-two"',
    'value="bad-time-three"',
  ]) {
    assert.match(invalid.stderr, new RegExp(expected));
  }
  assert.doesNotMatch(invalid.stderr, /Import plan/);
  assert.equal(
    store.listProjects().some(({ slug }) => slug === "invalid-cli-import"),
    false,
  );

  const malformedSource = makeRepository("malformed-json-import-source");
  mkdirSync(join(malformedSource, "docs", "session"), { recursive: true });
  writeFileSync(
    join(malformedSource, "docs", "session", "alpha.jsonl"),
    '{"id":"valid"}\n{"id": invalid-alpha}\n',
    "utf8",
  );
  writeFileSync(
    join(malformedSource, "docs", "session", "beta.jsonl"),
    '{"id": invalid-beta}\n',
    "utf8",
  );
  const malformed = await runCli(
    [
      "import",
      malformedSource,
      "--project",
      "malformed-cli-import",
      "--yes",
    ],
    controller,
  );
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /2 source field/);
  assert.match(malformed.stderr, /alpha\.jsonl:2 is not valid JSON/);
  assert.match(malformed.stderr, /beta\.jsonl:1 is not valid JSON/);
  assert.doesNotMatch(malformed.stderr, /Import plan/);
  assert.equal(
    store.listProjects().some(({ slug }) => slug === "malformed-cli-import"),
    false,
  );
});

test("service skill templates contain none of the retired file protocol", () => {
  const templatePaths = [
    "templates/skills/session-chat/SKILL.md",
    "templates/skills/design-handoff/SKILL.md",
    "templates/skills/grill-with-docs/SKILL.md",
  ];
  const templateContents = templatePaths.map((path) =>
    readFileSync(resolve(path), "utf8"),
  );
  const templates = templateContents.join("\n");
  for (const retired of [
    "jq -nc",
    "wc -l",
    "msg-NNNN",
    "tail -F",
    "ID 衝突",
  ]) {
    assert.equal(templates.includes(retired), false, retired);
  }
  for (const [index, content] of templateContents.entries()) {
    const path = templatePaths[index];
    assert.match(content, /ao watch (?:--project )?--once/, path);
    assert.match(
      content,
      /every two minutes|at least every\s+two minutes/,
      path,
    );
    assert.match(content, /persistent `ao watch`/, path);
    assert.match(content, /does not\s+update\s+your heartbeat/, path);
    assert.match(content, /hold (?:the ball|it)/, path);
    assert.match(content, /treated as\s+abandoned/, path);
    assert.match(content, /カスタム スケジュール/, path);
    assert.match(content, /Monitor/, path);
    assert.match(
      content,
      /(?:other|another).*unknown runtime|runtime is\s+different/,
      path,
    );
    assert.match(content, /do not invent|instead of inventing/, path);
    assert.doesNotMatch(content, /keep `ao watch` running/, path);
  }
  const sessionSkill = templateContents[0];
  assert.match(sessionSkill, /AO_CLI/);
  assert.match(sessionSkill, /cli\.command/);
  assert.match(sessionSkill, /takes precedence/);
  assert.match(
    sessionSkill,
    /AO_SERVER_URL.*repository `\.ao\/config\.json`.*~\/\.ao\/config\.json/s,
  );
  assert.match(sessionSkill, /Only `AO_SERVER_URL` overrides a repository/);
  assert.match(sessionSkill, /Which room number should I join\?/);
  assert.match(sessionSkill, /join-room\.mjs <NUMBER> --repo \./);
  assert.match(sessionSkill, /handoff.*`CONTEXT\.md`.*every ADR/s);
  assert.match(sessionSkill, /unanswered question.*before lower-priority work/s);
  assert.match(sessionSkill, /Begin the self-driven loop.*`ao watch --once`/s);
  assert.match(sessionSkill, /post a `status` start message/);
  assert.match(sessionSkill, /Never silently reuse an occupied implementer slot/);
  assert.match(
    sessionSkill,
    /`--identifier` \/ `--role`.*`AO_IDENTIFIER` \/ `AO_ROLE`.*repository `\.ao\/config\.json`/s,
  );
  assert.match(sessionSkill, /Do not write identity into\s+`~\/\.ao\/config\.json`/);
  assert.match(sessionSkill, /multiple\s+agents share one checkout/);
  const designerSkill = templateContents[1];
  assert.match(
    designerSkill,
    /AO_SERVER_URL.*repository\s+`\.ao\/config\.json`.*~\/\.ao\/config\.json/s,
  );
  assert.match(
    designerSkill,
    /project name as the only required owner\s+input/,
  );
  assert.match(designerSkill, /designer-start\.mjs <PROJECT>/);
  assert.match(designerSkill, /skeleton_grill\.required=true/);
  assert.match(designerSkill, /ao watch --project --once/);
  assert.match(designerSkill, /fans out to every work/);
  assert.match(designerSkill, /Publish before announcing/);
  assert.match(designerSkill, /Classify every open judgment/);
  assert.match(designerSkill, /passing test is not completion\s+evidence/i);
  assert.match(designerSkill, /heartbeat was\s+one second old/);
  assert.match(designerSkill, /Inspect diffs and artifacts/);
  assert.match(designerSkill, /Search\s+the entire source of truth/);
  assert.match(
    designerSkill,
    /four separate omissions or contradictions survived/,
  );
  assert.match(designerSkill, /Only the owner can\s+dismiss participants/);
  assert.match(designerSkill, /Never guess owner-specific facts/);
  assert.match(designerSkill, /`AO_IDENTIFIER=designer AO_ROLE=designer`/);
  assert.match(designerSkill, /Never put identity\s+in the user-level/);
  const designerScript = resolve(
    "templates/skills/design-handoff/scripts/designer-start.mjs",
  );
  assert.equal(existsSync(designerScript), true);
  assert.notEqual(statSync(designerScript).mode & 0o111, 0);
  for (const script of [
    "post-safe.mjs",
    "watch-passive.mjs",
    "self-driven-loop.mjs",
    "ball-check.mjs",
    "join-room.mjs",
  ]) {
    assert.match(sessionSkill, new RegExp(script.replace(".", "\\.")));
    const source = resolve("templates/skills/session-chat/scripts", script);
    assert.equal(existsSync(source), true, source);
    assert.notEqual(statSync(source).mode & 0o111, 0, source);
  }
  assert.equal(
    existsSync(
      resolve("templates/skills/session-chat/scripts/lib/ao-cli.mjs"),
    ),
    true,
  );
});

test("copy header stripping returns only the document body", () => {
  const content = `<!-- AgentOrchestrator: copy
     revision=7 / doc=context / pulled=now -->
body
`;
  assert.equal(cliInternals.stripCopyHeader(content), "body\n");
});
