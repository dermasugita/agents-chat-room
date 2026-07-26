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

before(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "ao-cli-test-"));
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

async function runCli(args, cwd) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env },
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
      env: { ...process.env },
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
      env: { ...process.env, ...env },
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
      env: { ...process.env, ...env },
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
    ".claude/skills/session-chat/scripts/lib/ao-cli.mjs",
    ".agents/skills/session-chat/scripts/lib/ao-cli.mjs",
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
    assert.match(content, /ao watch --once/, path);
    assert.match(
      content,
      /every two minutes|at least every\s+two minutes/,
      path,
    );
    assert.match(content, /persistent `ao watch`/, path);
    assert.match(content, /does not\s+update\s+your heartbeat/, path);
    assert.match(content, /hold (?:the ball|it)/, path);
    assert.match(content, /treated as abandoned/, path);
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
  for (const script of [
    "post-safe.mjs",
    "watch-passive.mjs",
    "self-driven-loop.mjs",
    "ball-check.mjs",
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
