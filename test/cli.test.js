import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
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

  for (const path of [
    ".ao/config.json",
    ".ao/docs/CONTEXT.md",
    ".claude/skills/session-chat/SKILL.md",
    ".agents/skills/session-chat/SKILL.md",
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
  const templates = [
    "templates/skills/session-chat/SKILL.md",
    "templates/skills/design-handoff/SKILL.md",
    "templates/skills/grill-with-docs/SKILL.md",
  ]
    .map((path) => readFileSync(resolve(path), "utf8"))
    .join("\n");
  for (const retired of [
    "jq -nc",
    "wc -l",
    "msg-NNNN",
    "tail -F",
    "ID 衝突",
  ]) {
    assert.equal(templates.includes(retired), false, retired);
  }
});

test("copy header stripping returns only the document body", () => {
  const content = `<!-- AgentOrchestrator: copy
     revision=7 / doc=context / pulled=now -->
body
`;
  assert.equal(cliInternals.stripCopyHeader(content), "body\n");
});
