import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COPY_MARKER = "AgentOrchestrator";
const INSTRUCTION_START = "<!-- agents-chat-room:instructions:start -->";
const INSTRUCTION_END = "<!-- agents-chat-room:instructions:end -->";
const TEMPLATE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../templates/skills",
);

const HELP = `agents-chat-room CLI

Usage:
  ao inject <repo> --server URL --identifier ID --role ROLE [--project SLUG] [--work SLUG] [--work-title TITLE]
  ao pull [DOC] [--force] [--repo PATH]
  ao push <DOC> [--note TEXT] [--repo PATH]
  ao post --type TYPE --body TEXT [--to ID[,ID]] [--reply-to SEQ] [--ball ID[,ID]]
  ao messages [--since SEQ]
  ao watch [--since SEQ] [--interval SECONDS] [--once]
  ao close <SEQ>
  ao resolve
  ao create-work <SLUG> --title TITLE
  ao create-document <context|adr|handoff> --title TITLE --file PATH [--slug SLUG]
  ao import <repo> [--yes] [--project SLUG] [--name NAME]

Configuration is read from .ao/config.json. AO_SERVER_URL can override server_url.
`;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.displayMessage = message;
    this.exitCode = exitCode;
  }
}

class ApiError extends CliError {
  constructor(status, body) {
    const detail = body?.message ?? body?.error ?? `HTTP ${status}`;
    super(`Server returned ${status}: ${detail}`, status === 409 ? 2 : 1);
    this.status = status;
    this.body = body;
  }
}

function parseArguments(argv) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    let name;
    let value;
    if (equals > 2) {
      name = token.slice(2, equals);
      value = token.slice(equals + 1);
    } else {
      name = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    const existing = options.get(name) ?? [];
    existing.push(value);
    options.set(name, existing);
  }
  return { options, positional };
}

function option(parsed, name, fallback = undefined) {
  const values = parsed.options.get(name);
  return values?.at(-1) ?? fallback;
}

function hasOption(parsed, name) {
  return parsed.options.has(name);
}

function optionList(parsed, name) {
  return (parsed.options.get(name) ?? []).flatMap((value) => {
    if (value === true || value === "") {
      return [];
    }
    return String(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  });
}

function requireOption(parsed, name) {
  const value = option(parsed, name);
  if (value === undefined || value === true || value === "") {
    throw new CliError(`--${name} is required`);
  }
  return String(value);
}

function readJson(path, fallback = undefined) {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(`Cannot parse ${path}: ${error.message}`);
  }
}

function writeJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function findRepository(start = process.cwd()) {
  let current = resolve(start);
  if (existsSync(current) && !statSync(current).isDirectory()) {
    current = dirname(current);
  }
  while (true) {
    if (existsSync(join(current, ".ao", "config.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new CliError(
        "No .ao/config.json found. Run `ao inject <repo>` or pass --repo.",
      );
    }
    current = parent;
  }
}

function loadContext(parsed) {
  const repository = findRepository(option(parsed, "repo", process.cwd()));
  const configPath = join(repository, ".ao", "config.json");
  const config = readJson(configPath);
  if (!config) {
    throw new CliError(`Missing configuration: ${configPath}`);
  }
  config.server_url = process.env.AO_SERVER_URL ?? config.server_url;
  if (!config.server_url || !config.project || !config.identifier || !config.role) {
    throw new CliError(`${configPath} is missing required fields`);
  }
  return {
    config,
    configPath,
    repository,
    statePath: join(repository, ".ao", "state.json"),
  };
}

function requireWork(context, parsed) {
  const work = option(parsed, "work", context.config.work);
  if (!work || work === true) {
    throw new CliError("A work slug is required in config.json or via --work");
  }
  return String(work);
}

function workApiPath(context, work) {
  return `/projects/${apiPath(context.config.project)}/works/${apiPath(work)}`;
}

function apiPath(value) {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function api(config, method, path, body = undefined) {
  const base = config.server_url.replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers:
        body === undefined
          ? { accept: "application/json" }
          : {
              accept: "application/json",
              "content-type": "application/json",
            },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new CliError(`Cannot reach ${base}: ${error.message}`);
  }
  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = { message: await response.text() };
  }
  if (!response.ok) {
    throw new ApiError(response.status, responseBody);
  }
  return responseBody;
}

function documentPath(repository, identifier) {
  if (identifier === "context") {
    return join(repository, ".ao", "docs", "CONTEXT.md");
  }
  const [kind, slug] = identifier.split("/");
  if ((kind !== "adr" && kind !== "handoff") || !slug) {
    throw new CliError(`Invalid document identifier: ${identifier}`);
  }
  return join(repository, ".ao", "docs", kind, `${slug}.md`);
}

function copyHeader(document, pulledAt) {
  return `<!-- ${COPY_MARKER}: これは写しです。正本はサーバ側 DB にあります。
     revision=${document.revision} / doc=${document.doc} / pulled=${pulledAt}
     編集しても \`ao push\` するまで正本に反映されません。\`ao pull\` で失われます。 -->
`;
}

function stripCopyHeader(content) {
  if (!content.startsWith(`<!-- ${COPY_MARKER}:`)) {
    return content;
  }
  const end = content.indexOf("-->");
  if (end < 0) {
    throw new CliError("The AgentOrchestrator copy header is malformed");
  }
  return content.slice(end + 3).replace(/^\r?\n/, "");
}

function writeDocumentCopy(repository, document) {
  const path = documentPath(repository, document.doc);
  const pulledAt = new Date().toISOString();
  atomicWrite(path, `${copyHeader(document, pulledAt)}${document.body}`);
  return {
    body_hash: hash(document.body),
    path: relative(repository, path),
    revision: document.revision,
  };
}

function assertCopiesClean(context, identifiers, state, force) {
  if (force) {
    return;
  }
  for (const identifier of identifiers) {
    const entry = state.documents?.[identifier];
    if (!entry) {
      continue;
    }
    const path = join(context.repository, entry.path);
    if (!existsSync(path)) {
      continue;
    }
    const body = stripCopyHeader(readFileSync(path, "utf8"));
    if (hash(body) !== entry.body_hash) {
      throw new CliError(
        `${entry.path} has unpushed edits. Push it first or repeat pull with --force.`,
        2,
      );
    }
  }
}

async function pullDocuments(context, requested = undefined, force = false) {
  const listing = await api(
    context.config,
    "GET",
    `/projects/${apiPath(context.config.project)}/documents`,
  );
  const identifiers = requested
    ? [requested]
    : listing.documents.map(({ doc }) => doc);
  const known = new Set(listing.documents.map(({ doc }) => doc));
  for (const identifier of identifiers) {
    if (!known.has(identifier)) {
      throw new CliError(`Document does not exist on the server: ${identifier}`);
    }
  }

  const state = readJson(context.statePath, {
    documents: {},
    server_url: context.config.server_url,
  });
  state.documents ??= {};
  assertCopiesClean(context, identifiers, state, force);

  const documents = [];
  for (const identifier of identifiers) {
    documents.push(
      await api(
        context.config,
        "GET",
        `/projects/${apiPath(context.config.project)}/documents/${apiPath(identifier)}`,
      ),
    );
  }
  for (const document of documents) {
    state.documents[document.doc] = writeDocumentCopy(context.repository, document);
  }
  state.server_url = context.config.server_url;
  state.project = context.config.project;
  writeJson(context.statePath, state);
  return documents;
}

async function pushDocument(context, identifier, note = undefined) {
  const state = readJson(context.statePath);
  const entry = state?.documents?.[identifier];
  if (!entry) {
    throw new CliError(`No pulled revision is recorded for ${identifier}`);
  }
  const path = join(context.repository, entry.path);
  if (!existsSync(path)) {
    throw new CliError(`Missing document copy: ${entry.path}`);
  }
  const body = stripCopyHeader(readFileSync(path, "utf8"));
  try {
    const result = await api(
      context.config,
      "PUT",
      `/projects/${apiPath(context.config.project)}/documents/${apiPath(identifier)}`,
      {
        author: context.config.identifier,
        base_revision: entry.revision,
        body,
        ...(note ? { note } : {}),
      },
    );
    const document = {
      body,
      doc: identifier,
      revision: result.revision,
    };
    state.documents[identifier] = writeDocumentCopy(context.repository, document);
    writeJson(context.statePath, state);
    return result;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) {
      throw error;
    }
    const rejectedPath = `${path}.rejected`;
    atomicWrite(rejectedPath, body);
    const current = {
      body: error.body.current_body,
      doc: identifier,
      revision: error.body.current_revision,
    };
    state.documents[identifier] = writeDocumentCopy(context.repository, current);
    writeJson(context.statePath, state);
    throw new CliError(
      `Revision conflict for ${identifier}. The server copy replaced the local copy; your rejected edit is saved at ${relative(context.repository, rejectedPath)}. Reapply it and push again.`,
      2,
    );
  }
}

function instructionBlock() {
  return `${INSTRUCTION_START}
This repository uses agents-chat-room. Read the service workflow skills under
\`.agents/skills/\` (Codex/runtime-neutral) or \`.claude/skills/\` (Claude Code).
Design documents are server-owned copies under \`.ao/docs/\`; use \`ao pull\` and
\`ao push\`. Use \`ao watch\` for thread events. Resolve is not permission to leave.
${INSTRUCTION_END}`;
}

function appendInstructionPointer(path) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes(INSTRUCTION_START)) {
    return false;
  }
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  atomicWrite(path, `${existing}${separator}\n${instructionBlock()}\n`);
  return true;
}

function backupPath(path) {
  let candidate = `${path}.bak`;
  let index = 1;
  while (existsSync(candidate)) {
    candidate = `${path}.bak.${index}`;
    index += 1;
  }
  return candidate;
}

function installSkillFile(source, target) {
  const content = readFileSync(source, "utf8");
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === content) {
      return { action: "unchanged", target };
    }
    const backup = backupPath(target);
    copyFileSync(target, backup);
    atomicWrite(target, content);
    return { action: "backed-up", backup, target };
  }
  atomicWrite(target, content);
  return { action: "created", target };
}

function installSkills(repository) {
  const results = [];
  for (const name of readdirSync(TEMPLATE_ROOT)) {
    const source = join(TEMPLATE_ROOT, name, "SKILL.md");
    if (!existsSync(source)) {
      continue;
    }
    for (const root of [".claude", ".agents"]) {
      results.push(
        installSkillFile(
          source,
          join(repository, root, "skills", name, "SKILL.md"),
        ),
      );
    }
  }
  appendInstructionPointer(join(repository, "CLAUDE.md"));
  appendInstructionPointer(join(repository, "AGENTS.md"));
  return results;
}

function ensureIgnored(repository) {
  const path = join(repository, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.split(/\r?\n/).includes("/.ao/")) {
    return;
  }
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${prefix}/.ao/\n`, "utf8");
}

function importCandidates(repository) {
  const candidates = [];
  for (const path of [
    join(repository, "CONTEXT.md"),
    join(repository, "docs", "adr"),
    join(repository, "docs", "handoff"),
    join(repository, "docs", "session"),
  ]) {
    if (existsSync(path)) {
      candidates.push(relative(repository, path));
    }
  }
  return candidates;
}

function markdownTitle(body, fallback) {
  const heading = String(body).match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() || fallback;
}

function markdownFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

function readSession(path) {
  const content = readFileSync(path, "utf8");
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new CliError(
        `${path}:${index + 1} is not valid JSON: ${error.message}`,
      );
    }
  });
}

function buildImportBundle(source, context, parsed) {
  const documents = [];
  const works = new Map();
  const sessions = [];
  const contextPath = join(source, "CONTEXT.md");
  if (existsSync(contextPath)) {
    const body = readFileSync(contextPath, "utf8");
    documents.push({
      author: "import",
      body,
      kind: "context",
      title: markdownTitle(body, "CONTEXT"),
    });
  }
  for (const name of markdownFiles(join(source, "docs", "adr"))) {
    const match = name.match(/^(\d+)-(.+)\.md$/);
    if (!match) {
      throw new CliError(
        `ADR filename must retain its numeric prefix: docs/adr/${name}`,
      );
    }
    const body = readFileSync(join(source, "docs", "adr", name), "utf8");
    documents.push({
      adr_number: Number(match[1]),
      author: "import",
      body,
      kind: "adr",
      slug: name.slice(0, -3),
      title: markdownTitle(body, name.slice(0, -3)),
    });
  }
  for (const name of markdownFiles(join(source, "docs", "handoff"))) {
    const slug = name.slice(0, -3);
    const body = readFileSync(join(source, "docs", "handoff", name), "utf8");
    documents.push({
      author: "import",
      body,
      kind: "handoff",
      slug,
      title: markdownTitle(body, slug),
      work_slug: slug,
    });
    works.set(slug, { slug, state: "open", title: markdownTitle(body, slug) });
  }
  const sessionDirectory = join(source, "docs", "session");
  if (existsSync(sessionDirectory)) {
    for (const name of readdirSync(sessionDirectory)
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort()) {
      const workSlug = name.slice(0, -6);
      sessions.push({
        messages: readSession(join(sessionDirectory, name)),
        title: works.get(workSlug)?.title ?? workSlug,
        work_slug: workSlug,
      });
      if (!works.has(workSlug)) {
        works.set(workSlug, { slug: workSlug, state: "open", title: workSlug });
      }
    }
  }
  const project = String(option(parsed, "project", context.config.project));
  return {
    documents,
    project: {
      name: String(option(parsed, "name", basename(source))),
      slug: project,
    },
    reuse_project: project === context.config.project,
    sessions,
    works: [...works.values()],
  };
}

async function importCommand(context, parsed) {
  const sourceValue = parsed.positional[1];
  if (!sourceValue) {
    throw new CliError("import requires a source repository path");
  }
  const source = resolve(sourceValue);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new CliError(`Import source not found: ${source}`);
  }
  const bundle = buildImportBundle(source, context, parsed);
  const summary = {
    documents: bundle.documents.length,
    messages: bundle.sessions.reduce(
      (count, session) => count + session.messages.length,
      0,
    ),
    project: bundle.project.slug,
    sessions: bundle.sessions.length,
    works: bundle.works.length,
  };
  console.error(`Import plan: ${JSON.stringify(summary)}`);
  if (!hasOption(parsed, "yes")) {
    throw new CliError(
      "Import has not run. Review the counts above, then repeat with --yes.",
      2,
    );
  }
  return api(context.config, "POST", "/import", bundle);
}

async function inject(parsed) {
  const target = parsed.positional[1];
  if (!target) {
    throw new CliError("inject requires a repository path");
  }
  const repository = resolve(target);
  if (!existsSync(repository) || !statSync(repository).isDirectory()) {
    throw new CliError(`Repository directory not found: ${repository}`);
  }
  const project =
    option(parsed, "project") ??
    basename(repository)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  const selectedWork = option(parsed, "work");
  if (
    hasOption(parsed, "work") &&
    (selectedWork === true || selectedWork === "")
  ) {
    throw new CliError("--work requires a value");
  }
  if (hasOption(parsed, "work-title") && !hasOption(parsed, "work")) {
    throw new CliError("--work-title requires --work");
  }
  const selectedWorkTitle = hasOption(parsed, "work-title")
    ? requireOption(parsed, "work-title")
    : undefined;
  const config = {
    server_url: String(option(parsed, "server", "http://127.0.0.1:7331")),
    project: String(project),
    identifier: requireOption(parsed, "identifier"),
    role: requireOption(parsed, "role"),
    ...(selectedWork ? { work: String(selectedWork) } : {}),
  };
  if (!["owner", "designer", "implementer"].includes(config.role)) {
    throw new CliError("--role must be owner, designer, or implementer");
  }

  try {
    await api(config, "POST", "/projects", {
      slug: config.project,
      name: String(option(parsed, "name", basename(repository))),
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) {
      throw error;
    }
    await api(config, "GET", `/projects/${apiPath(config.project)}`);
  }

  let work;
  if (config.work) {
    try {
      work = await api(
        config,
        "POST",
        `/projects/${apiPath(config.project)}/works`,
        {
          slug: config.work,
          title: selectedWorkTitle ?? config.work,
        },
      );
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status !== 409 ||
        error.body?.error !== "work_exists"
      ) {
        throw error;
      }
      work = await api(
        config,
        "GET",
        `/projects/${apiPath(config.project)}/works/${apiPath(config.work)}`,
      );
    }
  }

  mkdirSync(join(repository, ".ao", "docs"), { recursive: true });
  writeJson(join(repository, ".ao", "config.json"), config);
  const context = {
    config,
    repository,
    statePath: join(repository, ".ao", "state.json"),
  };
  const skills = installSkills(repository);
  ensureIgnored(repository);
  const documents = await pullDocuments(context, undefined, true);
  const candidates = importCandidates(repository);
  return {
    candidates,
    documents: documents.length,
    project: config.project,
    skills,
    ...(work ? { work } : {}),
  };
}

function parseExpectations(parsed) {
  return optionList(parsed, "expect").map((item) => {
    const separator = item.lastIndexOf("=");
    if (separator < 1) {
      throw new CliError(`Invalid --expect value: ${item}; use doc=revision`);
    }
    const revision = Number(item.slice(separator + 1));
    if (!Number.isInteger(revision) || revision < 1) {
      throw new CliError(`Invalid expected revision: ${item}`);
    }
    return { doc: item.slice(0, separator), revision };
  });
}

async function postCommand(context, parsed) {
  const work = requireWork(context, parsed);
  const type = requireOption(parsed, "type");
  let body = option(parsed, "body");
  if (body === undefined && option(parsed, "body-file")) {
    body = readFileSync(String(option(parsed, "body-file")), "utf8");
  }
  if (body === undefined || body === true) {
    throw new CliError("--body or --body-file is required");
  }
  const payload = {
    idempotency_key: String(option(parsed, "idempotency-key", randomUUID())),
    from: context.config.identifier,
    role: context.config.role,
    type,
    body: String(body),
    to: optionList(parsed, "to"),
    refs: optionList(parsed, "ref"),
    expects: parseExpectations(parsed),
  };
  if (option(parsed, "reply-to") !== undefined) {
    payload.reply_to = Number(option(parsed, "reply-to"));
  }
  if (hasOption(parsed, "ball")) {
    payload.ball = optionList(parsed, "ball");
  }
  return api(
    context.config,
    "POST",
    `${workApiPath(context, work)}/messages`,
    payload,
  );
}

function messageLine(message) {
  const body = JSON.stringify(message.body);
  return `MESSAGE seq=${message.seq} type=${message.type} from=${message.from} to=${message.to.join(",")} body=${body}`;
}

function emitPoll(result) {
  for (const message of result.messages) {
    console.log(messageLine(message));
  }
  if (result.idle_nudge) {
    console.log(`IDLE ${result.idle_nudge}`);
  }
  for (const participant of result.abandoned) {
    console.log(
      `ABANDONED identifier=${participant.identifier} last_heartbeat_at=${participant.last_heartbeat_at ?? "never"} reasons=${JSON.stringify(participant.ball_reasons)}`,
    );
  }
  for (const expectation of result.stale_expectations) {
    console.log(
      `STALE doc=${expectation.doc} you_have=${expectation.you_have} current=${expectation.current}`,
    );
  }
  if (result.your_ball.has_ball) {
    console.log(`BALL reasons=${JSON.stringify(result.your_ball.reasons)}`);
  }
}

async function watch(context, parsed) {
  const work = requireWork(context, parsed);
  const once = hasOption(parsed, "once");
  const interval = Number(option(parsed, "interval", 10)) * 1_000;
  if (!Number.isFinite(interval) || interval < 10) {
    throw new CliError("--interval must be at least 0.01 seconds");
  }
  let since = Number(option(parsed, "since", 0));
  if (!Number.isInteger(since) || since < 0) {
    throw new CliError("--since must be a non-negative integer");
  }
  let failures = 0;
  while (true) {
    try {
      const query = new URLSearchParams({
        as: context.config.identifier,
        role: context.config.role,
        since: String(since),
      });
      const result = await api(
        context.config,
        "GET",
        `${workApiPath(context, work)}/poll?${query}`,
      );
      emitPoll(result);
      if (result.messages.length > 0) {
        since = result.messages.at(-1).seq;
      }
      failures = 0;
    } catch (error) {
      failures += 1;
      console.error(
        `ERROR watch failure=${failures} ${error.displayMessage ?? error.message}`,
      );
      if (once) {
        throw error;
      }
    }
    if (once) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, interval));
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv) {
  const parsed = parseArguments(argv);
  const command = parsed.positional[0];
  if (!command || command === "help" || hasOption(parsed, "help")) {
    process.stdout.write(HELP);
    return;
  }

  if (command === "inject") {
    print(await inject(parsed));
    return;
  }

  const context = loadContext(parsed);
  if (command === "pull") {
    print(
      await pullDocuments(
        context,
        parsed.positional[1],
        hasOption(parsed, "force"),
      ),
    );
    return;
  }
  if (command === "push") {
    const identifier = parsed.positional[1];
    if (!identifier) {
      throw new CliError("push requires a document identifier");
    }
    print(await pushDocument(context, identifier, option(parsed, "note")));
    return;
  }
  if (command === "post") {
    print(await postCommand(context, parsed));
    return;
  }
  if (command === "messages") {
    const work = requireWork(context, parsed);
    const since = Number(option(parsed, "since", 0));
    const result = await api(
      context.config,
      "GET",
      `${workApiPath(context, work)}/messages?since=${since}`,
    );
    for (const message of result.messages) {
      console.log(messageLine(message));
    }
    return;
  }
  if (command === "watch") {
    await watch(context, parsed);
    return;
  }
  if (command === "close") {
    const work = requireWork(context, parsed);
    const seq = Number(parsed.positional[1]);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new CliError("close requires a positive message sequence");
    }
    print(
      await api(
        context.config,
        "POST",
        `${workApiPath(context, work)}/messages/${seq}/close`,
        {
          from: context.config.identifier,
        },
      ),
    );
    return;
  }
  if (command === "resolve") {
    const work = requireWork(context, parsed);
    print(
      await api(
        context.config,
        "POST",
        `${workApiPath(context, work)}/resolve`,
        {},
      ),
    );
    return;
  }
  if (command === "create-work") {
    const slug = parsed.positional[1];
    if (!slug) {
      throw new CliError("create-work requires a slug");
    }
    print(
      await api(
        context.config,
        "POST",
        `/projects/${apiPath(context.config.project)}/works`,
        { slug, title: requireOption(parsed, "title") },
      ),
    );
    return;
  }
  if (command === "create-document") {
    const kind = parsed.positional[1];
    if (!kind) {
      throw new CliError("create-document requires a kind");
    }
    const file = requireOption(parsed, "file");
    print(
      await api(
        context.config,
        "POST",
        `/projects/${apiPath(context.config.project)}/documents`,
        {
          kind,
          title: requireOption(parsed, "title"),
          body: readFileSync(file, "utf8"),
          author: context.config.identifier,
          ...(option(parsed, "slug") ? { slug: option(parsed, "slug") } : {}),
        },
      ),
    );
    return;
  }
  if (command === "import") {
    print(await importCommand(context, parsed));
    return;
  }

  throw new CliError(`Unknown command: ${command}\n\n${HELP}`);
}

export const cliInternals = {
  apiPath,
  documentPath,
  hash,
  parseArguments,
  stripCopyHeader,
};
