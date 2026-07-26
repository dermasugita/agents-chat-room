import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COPY_MARKER = "AgentOrchestrator";
const INSTRUCTION_START = "<!-- agents-chat-room:instructions:start -->";
const INSTRUCTION_END = "<!-- agents-chat-room:instructions:end -->";
const TEMPLATE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../templates/skills",
);
const CLI_ENTRYPOINT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../bin/ao.js",
);

const HELP = `agents-chat-room CLI

Usage:
  ao configure --server URL
  ao projects [--json]
  ao design <PROJECT> [--repo PATH] [--identifier ID] [--role designer]
  ao rooms [--json] [--repo PATH]
  ao join <NUMBER|PROJECT/WORK> [--repo PATH] [--identifier ID] [--role ROLE] [--confirm-occupied]
  ao inject <repo> --server URL [--identifier ID] [--role ROLE] [--project SLUG] [--work SLUG] [--work-title TITLE]
  ao pull [DOC] [--force] [--repo PATH] [--identifier ID] [--role ROLE]
  ao push <DOC> [--note TEXT] [--repo PATH] [--identifier ID] [--role ROLE]
  ao post --type TYPE --body TEXT [--to ID[,ID]] [--reply-to SEQ] [--ball ID[,ID]] [--identifier ID] [--role ROLE]
  ao messages [--since SEQ] [--identifier ID] [--role ROLE]
  ao watch [--project] [--since SEQ] [--interval SECONDS] [--once] [--identifier ID] [--role ROLE]
  ao close <SEQ> [--identifier ID] [--role ROLE]
  ao resolve [--identifier ID] [--role ROLE]
  ao create-work <SLUG> --title TITLE [--implementer ID]
  ao create-document <context|adr|handoff> --title TITLE --file PATH [--slug SLUG]
  ao delete-project <PROJECT> --confirm PROJECT [--delete-nonempty] [--repo PATH]
  ao delete-work <PROJECT> <WORK> --confirm WORK [--delete-nonempty] [--repo PATH]
  ao delete-participant <PROJECT> <WORK> <IDENTIFIER> [--repo PATH]
  ao issue-create <PROJECT> --title TITLE --body TEXT [--repo PATH]
  ao issues [PROJECT] [--state open|closed|all] [--repo PATH]
  ao issue <PROJECT> <NUMBER> [--repo PATH]
  ao issue-comment <PROJECT> <NUMBER> --body TEXT [--repo PATH]
  ao issue-close <PROJECT> <NUMBER> --reason TEXT [--repo PATH]
  ao issue-reopen <PROJECT> <NUMBER> [--repo PATH]
  ao import <repo> [--yes] [--project SLUG] [--name NAME]

Server resolution order is AO_SERVER_URL, repository .ao/config.json, then
~/.ao/config.json. Run ao configure once to write the user default.

Identity resolution order is --identifier/--role, AO_IDENTIFIER/AO_ROLE, then
repository .ao/config.json. Identity belongs to an agent, not a repository.
`;

const CONTEXT_OPTIONS = ["repo", "work", "identifier", "role"];
const COMMAND_OPTIONS = new Map([
  ["configure", ["server"]],
  ["projects", ["json", "repo"]],
  ["design", ["repo", "identifier", "role", "force"]],
  ["rooms", ["json", "repo"]],
  ["join", ["repo", "identifier", "role", "confirm-occupied", "force"]],
  [
    "inject",
    [
      "server",
      "identifier",
      "role",
      "project",
      "work",
      "work-title",
      "name",
    ],
  ],
  ["delete-project", ["confirm", "delete-nonempty", "repo"]],
  ["delete-work", ["confirm", "delete-nonempty", "repo"]],
  ["delete-participant", ["repo"]],
  ["pull", [...CONTEXT_OPTIONS, "force"]],
  ["push", [...CONTEXT_OPTIONS, "note"]],
  [
    "post",
    [
      ...CONTEXT_OPTIONS,
      "type",
      "body",
      "body-file",
      "to",
      "reply-to",
      "ball",
      "idempotency-key",
      "expect",
      "ref",
    ],
  ],
  ["messages", [...CONTEXT_OPTIONS, "since"]],
  ["watch", [...CONTEXT_OPTIONS, "project", "since", "interval", "once"]],
  ["close", CONTEXT_OPTIONS],
  ["resolve", CONTEXT_OPTIONS],
  ["create-work", [...CONTEXT_OPTIONS, "title", "implementer"]],
  ["create-document", [...CONTEXT_OPTIONS, "title", "file", "slug"]],
  ["import", [...CONTEXT_OPTIONS, "yes", "project", "name"]],
  ["issue-create", ["title", "body", "repo"]],
  ["issues", ["state", "repo"]],
  ["issue", ["repo"]],
  ["issue-comment", ["body", "repo"]],
  ["issue-close", ["reason", "repo"]],
  ["issue-reopen", ["repo"]],
]);

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
    const issues = Array.isArray(body?.errors)
      ? body.errors
          .map((issue) => {
            const location = [
              issue.work ? `work=${issue.work}` : null,
              issue.line ? `line=${issue.line}` : null,
              issue.id ? `id=${issue.id}` : null,
              issue.doc ? `doc=${issue.doc}` : null,
              issue.field ? `field=${issue.field}` : null,
            ]
              .filter(Boolean)
              .join(" ");
            return `- ${location} value=${JSON.stringify(issue.value)} ${issue.message}`;
          })
          .join("\n")
      : "";
    super(
      `Server returned ${status}: ${detail}${issues ? `\n${issues}` : ""}`,
      status === 409 ? 2 : 1,
    );
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

function booleanFlag(parsed, name) {
  const values = parsed.options.get(name) ?? [];
  if (values.some((value) => value !== true)) {
    throw new CliError(`--${name} does not take a value`);
  }
  return values.length > 0;
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

function assertKnownOptions(command, parsed) {
  const allowed = COMMAND_OPTIONS.get(command);
  if (!allowed) {
    throw new CliError(`Unknown command: ${command}\n\n${HELP}`);
  }
  const allowedSet = new Set(allowed);
  for (const name of parsed.options.keys()) {
    if (!allowedSet.has(name)) {
      throw new CliError(
        `Unknown option --${name} for ao ${command}. Run \`ao help\` for supported options.`,
      );
    }
  }
}

function rejectUnknownOptions(parsed, allowed) {
  for (const name of parsed.options.keys()) {
    if (!allowed.has(name)) {
      throw new CliError(`Unknown option --${name}`);
    }
  }
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

function findRepositoryOptional(start = process.cwd()) {
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
      return null;
    }
    current = parent;
  }
}

function findRepository(start = process.cwd()) {
  const repository = findRepositoryOptional(start);
  if (!repository) {
    throw new CliError(
      "No .ao/config.json found. Run `ao join` or `ao inject <repo>`, or pass --repo.",
    );
  }
  return repository;
}

function userConfigPath(options = {}) {
  const environment = options.environment ?? process.env;
  const homeDirectory =
    options.homeDirectory ??
    (typeof environment.HOME === "string" && environment.HOME.trim()
      ? resolve(environment.HOME)
      : homedir());
  return join(homeDirectory, ".ao", "config.json");
}

function validServerUrl(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function validIdentityValue(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function resolveIdentity(parsed, repositoryConfig = {}, options = {}) {
  const environment = options.environment ?? process.env;
  const defaults = options.defaults ?? {};
  const explicitIdentifier = hasOption(parsed, "identifier")
    ? requireOption(parsed, "identifier")
    : null;
  const explicitRole = hasOption(parsed, "role")
    ? requireOption(parsed, "role")
    : null;
  const identifier =
    validIdentityValue(explicitIdentifier) ??
    validIdentityValue(environment.AO_IDENTIFIER) ??
    validIdentityValue(repositoryConfig?.identifier) ??
    validIdentityValue(defaults.identifier);
  const role =
    validIdentityValue(explicitRole) ??
    validIdentityValue(environment.AO_ROLE) ??
    validIdentityValue(repositoryConfig?.role) ??
    validIdentityValue(defaults.role);

  if (!identifier) {
    throw new CliError(
      "Cannot resolve the participant identifier. Pass --identifier, set AO_IDENTIFIER, or configure identifier in repository .ao/config.json.",
    );
  }
  if (!role) {
    throw new CliError(
      "Cannot resolve the participant role. Pass --role, set AO_ROLE, or configure role in repository .ao/config.json.",
    );
  }
  if (!["owner", "designer", "implementer"].includes(role)) {
    throw new CliError(
      `Invalid participant role ${JSON.stringify(role)}; expected owner, designer, or implementer.`,
    );
  }

  return {
    identifier,
    role,
    identifier_source: explicitIdentifier
      ? "--identifier"
      : validIdentityValue(environment.AO_IDENTIFIER)
        ? "AO_IDENTIFIER"
        : validIdentityValue(repositoryConfig?.identifier)
          ? "repository .ao/config.json"
          : "default",
    role_source: explicitRole
      ? "--role"
      : validIdentityValue(environment.AO_ROLE)
        ? "AO_ROLE"
        : validIdentityValue(repositoryConfig?.role)
          ? "repository .ao/config.json"
          : "default",
  };
}

function warnIdentityOverwrite(operation, configPath, existingConfig, identity) {
  const changes = [];
  const existingIdentifier = validIdentityValue(existingConfig?.identifier);
  const existingRole = validIdentityValue(existingConfig?.role);
  if (existingIdentifier && existingIdentifier !== identity.identifier) {
    changes.push(
      `identifier ${JSON.stringify(existingIdentifier)} -> ${JSON.stringify(identity.identifier)}`,
    );
  }
  if (existingRole && existingRole !== identity.role) {
    changes.push(
      `role ${JSON.stringify(existingRole)} -> ${JSON.stringify(identity.role)}`,
    );
  }
  if (changes.length === 0) {
    return;
  }
  console.error(
    `WARNING: ao ${operation} will overwrite agent identity in ${configPath}: ${changes.join(", ")}. Shared repositories need --identifier/--role or AO_IDENTIFIER/AO_ROLE per agent.`,
  );
}

function warnIgnoredUserIdentity(configPath, config, { removing = false } = {}) {
  const ignoredIdentity = [
    validIdentityValue(config?.identifier)
      ? `identifier=${JSON.stringify(config.identifier)}`
      : null,
    validIdentityValue(config?.role)
      ? `role=${JSON.stringify(config.role)}`
      : null,
  ].filter(Boolean);
  if (ignoredIdentity.length === 0) {
    return;
  }
  console.error(
    `WARNING: ${removing ? "ignoring and removing" : "ignoring"} agent identity from user configuration ${configPath}: ${ignoredIdentity.join(", ")}. Identity must come from --identifier/--role, AO_IDENTIFIER/AO_ROLE, or repository config.`,
  );
}

function resolveServerUrl(parsed, options = {}) {
  const environment = options.environment ?? process.env;
  const fromEnvironment = validServerUrl(environment.AO_SERVER_URL);
  if (fromEnvironment) {
    return { server_url: fromEnvironment, source: "AO_SERVER_URL" };
  }

  const requestedRepository = option(parsed, "repo");
  const repository = requestedRepository
    ? resolve(String(requestedRepository))
    : findRepositoryOptional(options.cwd ?? process.cwd());
  const repositoryPath = repository
    ? join(repository, ".ao", "config.json")
    : null;
  const repositoryConfig = repositoryPath
    ? readJson(repositoryPath)
    : undefined;
  const fromRepository = validServerUrl(repositoryConfig?.server_url);
  if (fromRepository) {
    return { server_url: fromRepository, source: repositoryPath };
  }

  const userPath = userConfigPath({
    environment,
    homeDirectory: options.homeDirectory,
  });
  const userConfig = readJson(userPath);
  warnIgnoredUserIdentity(userPath, userConfig);
  const fromUser = validServerUrl(userConfig?.server_url);
  if (fromUser) {
    return { server_url: fromUser, source: userPath };
  }

  throw new CliError(
    `Cannot resolve the server URL. AO_SERVER_URL is not set; ${
      repositoryPath ?? "no repository .ao/config.json was found"
    }; ${userPath} has no server_url. Run \`ao configure --server URL\` once.`,
  );
}

function loadContext(parsed) {
  const repository = findRepository(option(parsed, "repo", process.cwd()));
  const configPath = join(repository, ".ao", "config.json");
  const repositoryConfig = readJson(configPath);
  if (!repositoryConfig) {
    throw new CliError(`Missing configuration: ${configPath}`);
  }
  const identity = resolveIdentity(parsed, repositoryConfig);
  const config = {
    ...repositoryConfig,
    server_url: resolveServerUrl(parsed).server_url,
    identifier: identity.identifier,
    role: identity.role,
  };
  if (!config.server_url || !config.project) {
    throw new CliError(`${configPath} is missing required fields`);
  }
  return {
    config,
    configPath,
    identity,
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

async function pollWork(context, work, { heartbeat = true, since = 0 } = {}) {
  const query = new URLSearchParams({
    as: context.config.identifier,
    role: context.config.role,
    since: String(since),
  });
  if (!heartbeat) {
    query.set("heartbeat", "false");
  }
  return api(
    context.config,
    "GET",
    `${workApiPath(context, work)}/poll?${query}`,
  );
}

async function activeHeartbeat(context, parsed) {
  const selectedWork = option(parsed, "work", context.config.work);
  if (selectedWork === undefined || selectedWork === true || selectedWork === "") {
    return;
  }
  await pollWork(context, String(selectedWork));
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

function configure(parsed) {
  const path = userConfigPath();
  const existing = readJson(path, {});
  const serverUrl = requireOption(parsed, "server");
  warnIgnoredUserIdentity(path, existing, { removing: true });
  const {
    identifier: _ignoredIdentifier,
    role: _ignoredRole,
    ...serverDefaults
  } = existing;
  writeJson(path, { ...serverDefaults, server_url: serverUrl });
  return { path, server_url: serverUrl };
}

async function fetchRooms(parsed) {
  const resolvedServer = resolveServerUrl(parsed);
  const result = await api(resolvedServer, "GET", "/rooms");
  return {
    rooms: result.rooms,
    server: resolvedServer,
  };
}

async function fetchProjects(parsed) {
  const resolvedServer = resolveServerUrl(parsed);
  const result = await api(resolvedServer, "GET", "/projects");
  return {
    projects: result.projects,
    server: resolvedServer,
  };
}

async function projectsCommand(parsed) {
  const listing = await fetchProjects(parsed);
  if (hasOption(parsed, "json")) {
    print(listing);
    return;
  }
  if (listing.projects.length === 0) {
    console.log("No projects exist yet. Provide a project name to create one.");
    return;
  }
  console.log("Available projects:");
  listing.projects.forEach((project, index) => {
    console.log(
      `${index + 1}. ${project.slug}  ${project.name}  works=${project.work_count} documents=${project.document_count}`,
    );
  });
}

function requiredArgument(parsed, index, usage) {
  const value = parsed.positional[index];
  if (value === undefined || String(value).length === 0) {
    throw new CliError(`Usage: ${usage}`);
  }
  return String(value);
}

async function deleteProjectCommand(parsed) {
  const project = requiredArgument(
    parsed,
    1,
    "ao delete-project <PROJECT> --confirm PROJECT [--delete-nonempty] [--repo PATH]",
  );
  const deleteNonempty = booleanFlag(parsed, "delete-nonempty");
  const resolvedServer = resolveServerUrl(parsed);
  const preview = await api(
    resolvedServer,
    "GET",
    `/projects/${encodeURIComponent(project)}/deletion-preview`,
  );
  printDeletionPreview(preview);
  const query = new URLSearchParams({
    confirm: requireOption(parsed, "confirm"),
  });
  if (deleteNonempty) {
    query.set("delete_nonempty", "true");
  }
  return api(
    resolvedServer,
    "DELETE",
    `/projects/${encodeURIComponent(project)}?${query}`,
  );
}

async function deleteWorkCommand(parsed) {
  const project = requiredArgument(
    parsed,
    1,
    "ao delete-work <PROJECT> <WORK> --confirm WORK [--delete-nonempty] [--repo PATH]",
  );
  const work = requiredArgument(
    parsed,
    2,
    "ao delete-work <PROJECT> <WORK> --confirm WORK [--delete-nonempty] [--repo PATH]",
  );
  const deleteNonempty = booleanFlag(parsed, "delete-nonempty");
  const resolvedServer = resolveServerUrl(parsed);
  const preview = await api(
    resolvedServer,
    "GET",
    `/projects/${encodeURIComponent(project)}/works/${encodeURIComponent(work)}/deletion-preview`,
  );
  printDeletionPreview(preview);
  const query = new URLSearchParams({
    confirm: requireOption(parsed, "confirm"),
  });
  if (deleteNonempty) {
    query.set("delete_nonempty", "true");
  }
  return api(
    resolvedServer,
    "DELETE",
    `/projects/${encodeURIComponent(project)}/works/${encodeURIComponent(work)}?${query}`,
  );
}

function printDeletionPreview(preview) {
  const target = preview.target.work
    ? `${preview.target.project}/${preview.target.work}`
    : preview.target.project;
  const totals = preview.totals;
  console.error(`Deletion preview for ${target}:`);
  console.error(
    `  projects=${totals.projects} works=${totals.works} messages=${totals.messages} participants=${totals.participants} documents=${totals.documents} revisions=${totals.revisions}`,
  );
  if (preview.works.length === 0) {
    console.error("  works: none");
    return;
  }
  for (const work of preview.works) {
    const participants =
      work.heartbeat_participants.length === 0
        ? "none"
        : work.heartbeat_participants
            .map(
              ({ identifier, last_heartbeat_at: heartbeat }) =>
                `${identifier}@${heartbeat}`,
            )
            .join(",");
    console.error(
      `  work=${work.slug} messages=${work.message_count} last_updated_at=${work.last_updated_at} heartbeat_participants=${participants}`,
    );
  }
}

async function deleteParticipantCommand(parsed) {
  const project = requiredArgument(
    parsed,
    1,
    "ao delete-participant <PROJECT> <WORK> <IDENTIFIER> [--repo PATH]",
  );
  const work = requiredArgument(
    parsed,
    2,
    "ao delete-participant <PROJECT> <WORK> <IDENTIFIER> [--repo PATH]",
  );
  const identifier = requiredArgument(
    parsed,
    3,
    "ao delete-participant <PROJECT> <WORK> <IDENTIFIER> [--repo PATH]",
  );
  return api(
    resolveServerUrl(parsed),
    "DELETE",
    `/projects/${encodeURIComponent(project)}/works/${encodeURIComponent(work)}/participants/${encodeURIComponent(identifier)}`,
  );
}

function issueIdentity(context) {
  return {
    origin_project: context.config.project,
    origin_identifier: context.config.identifier,
    origin_role: context.config.role,
    ...(context.config.work ? { origin_work: context.config.work } : {}),
  };
}

function issueNumberArgument(parsed, index, usage) {
  const number = Number(requiredArgument(parsed, index, usage));
  if (!Number.isInteger(number) || number < 1) {
    throw new CliError(`Usage: ${usage}`);
  }
  return number;
}

function assertPositionalCount(parsed, count, usage) {
  if (parsed.positional.length !== count) {
    throw new CliError(`Usage: ${usage}`);
  }
}

async function issueCreateCommand(context, parsed) {
  const usage =
    "ao issue-create <PROJECT> --title TITLE --body TEXT [--repo PATH]";
  rejectUnknownOptions(parsed, new Set(["title", "body", "repo"]));
  assertPositionalCount(parsed, 2, usage);
  const project = requiredArgument(parsed, 1, usage);
  return api(
    context.config,
    "POST",
    `/projects/${apiPath(project)}/issues`,
    {
      title: requireOption(parsed, "title"),
      body: requireOption(parsed, "body"),
      ...issueIdentity(context),
    },
  );
}

async function issuesCommand(context, parsed) {
  const usage = "ao issues [PROJECT] [--state open|closed|all] [--repo PATH]";
  rejectUnknownOptions(parsed, new Set(["state", "repo"]));
  if (parsed.positional.length > 2) {
    throw new CliError(`Usage: ${usage}`);
  }
  const state = String(option(parsed, "state", "open"));
  if (!["open", "closed", "all"].includes(state)) {
    throw new CliError("--state must be open, closed, or all");
  }
  const query = new URLSearchParams({ state });
  const project = parsed.positional[1];
  return project
    ? api(
        context.config,
        "GET",
        `/projects/${apiPath(String(project))}/issues?${query}`,
      )
    : api(context.config, "GET", `/issues?${query}`);
}

async function issueDetailCommand(context, parsed) {
  const usage = "ao issue <PROJECT> <NUMBER> [--repo PATH]";
  rejectUnknownOptions(parsed, new Set(["repo"]));
  assertPositionalCount(parsed, 3, usage);
  const project = requiredArgument(parsed, 1, usage);
  const number = issueNumberArgument(parsed, 2, usage);
  return api(
    context.config,
    "GET",
    `/projects/${apiPath(project)}/issues/${number}`,
  );
}

async function issueCommentCommand(context, parsed) {
  const usage =
    "ao issue-comment <PROJECT> <NUMBER> --body TEXT [--repo PATH]";
  rejectUnknownOptions(parsed, new Set(["body", "repo"]));
  assertPositionalCount(parsed, 3, usage);
  const project = requiredArgument(parsed, 1, usage);
  const number = issueNumberArgument(parsed, 2, usage);
  return api(
    context.config,
    "POST",
    `/projects/${apiPath(project)}/issues/${number}/comments`,
    {
      body: requireOption(parsed, "body"),
      ...issueIdentity(context),
    },
  );
}

async function issueCloseCommand(context, parsed) {
  const usage =
    "ao issue-close <PROJECT> <NUMBER> --reason TEXT [--repo PATH]";
  rejectUnknownOptions(parsed, new Set(["reason", "repo"]));
  assertPositionalCount(parsed, 3, usage);
  const project = requiredArgument(parsed, 1, usage);
  const number = issueNumberArgument(parsed, 2, usage);
  return api(
    context.config,
    "POST",
    `/projects/${apiPath(project)}/issues/${number}/close`,
    {
      reason: requireOption(parsed, "reason"),
      ...issueIdentity(context),
    },
  );
}

async function issueReopenCommand(context, parsed) {
  const usage = "ao issue-reopen <PROJECT> <NUMBER> [--repo PATH]";
  rejectUnknownOptions(parsed, new Set(["repo"]));
  assertPositionalCount(parsed, 3, usage);
  const project = requiredArgument(parsed, 1, usage);
  const number = issueNumberArgument(parsed, 2, usage);
  return api(
    context.config,
    "POST",
    `/projects/${apiPath(project)}/issues/${number}/reopen`,
    {},
  );
}

function projectSlug(value) {
  const normalized = String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `project-${hash(String(value)).slice(0, 8)}`;
}

async function designProject(parsed) {
  const requested = parsed.positional[1];
  if (!requested) {
    await projectsCommand(parsed);
    return null;
  }
  const repository = resolve(String(option(parsed, "repo", process.cwd())));
  if (!existsSync(repository) || !statSync(repository).isDirectory()) {
    throw new CliError(`Repository directory not found: ${repository}`);
  }
  const listing = await fetchProjects(parsed);
  const requestedText = String(requested).trim();
  if (!requestedText) {
    throw new CliError("design requires a non-empty project name");
  }
  let project = listing.projects.find(
    (candidate) =>
      candidate.slug === requestedText ||
      candidate.name.toLowerCase() === requestedText.toLowerCase(),
  );
  let created = false;
  if (!project) {
    const slug = projectSlug(requestedText);
    try {
      project = await api(listing.server, "POST", "/projects", {
        slug,
        name: requestedText,
      });
      created = true;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) {
        throw error;
      }
      project = await api(
        listing.server,
        "GET",
        `/projects/${apiPath(slug)}`,
      );
    }
  }
  const projectDetails = await api(
    listing.server,
    "GET",
    `/projects/${apiPath(project.slug)}`,
  );
  const configPath = join(repository, ".ao", "config.json");
  const existingConfig = readJson(configPath);
  const existingDesignerConfig =
    existingConfig?.role === "designer" ? existingConfig : {};
  const identity = resolveIdentity(parsed, existingDesignerConfig, {
    defaults: { identifier: "designer", role: "designer" },
  });
  if (identity.role !== "designer") {
    throw new CliError(
      `ao design requires role designer; resolved ${identity.role} from ${identity.role_source}.`,
    );
  }
  const config = {
    server_url: listing.server.server_url,
    project: project.slug,
    identifier: identity.identifier,
    role: identity.role,
    cli: {
      command: process.execPath,
      args: [CLI_ENTRYPOINT],
    },
  };
  warnIdentityOverwrite("design", configPath, existingConfig, identity);
  mkdirSync(join(repository, ".ao", "docs"), { recursive: true });
  writeJson(configPath, config);
  const context = {
    config,
    configPath,
    repository,
    statePath: join(repository, ".ao", "state.json"),
  };
  const skills = installSkills(repository);
  ensureIgnored(repository);
  const documents = await pullDocuments(
    context,
    undefined,
    hasOption(parsed, "force"),
  );
  const threads = await Promise.all(
    projectDetails.works.map(async (work) => ({
      work: work.slug,
      result: await pollWork(context, work.slug, {
        heartbeat: true,
        since: 0,
      }),
    })),
  );
  const state = readJson(context.statePath, { documents: {} });
  state.project_messages ??= {};
  for (const thread of threads) {
    state.project_messages[thread.work] =
      thread.result.messages.at(-1)?.seq ?? 0;
  }
  writeJson(context.statePath, state);
  return {
    created,
    project: {
      slug: project.slug,
      name: project.name,
    },
    config: {
      ...config,
      server_source: listing.server.source,
    },
    documents: documents.map(({ doc, revision }) => ({
      doc,
      path: relative(repository, documentPath(repository, doc)),
      revision,
    })),
    threads: threads.map(({ work, result }) => ({
      work,
      messages: result.messages,
      your_ball: result.your_ball,
      idle_nudge: result.idle_nudge,
      abandoned: result.abandoned,
      stale_expectations: result.stale_expectations,
      heartbeat_at: result.heartbeat_at,
    })),
    skills,
    ...(created
      ? {
          skeleton_grill: {
            required: true,
            first_branches: [
              "Who is the user and what outcome must change?",
              "What is in scope and explicitly out of scope?",
              "Which terms and invariants belong in CONTEXT?",
              "Which alternatives and tradeoffs require an ADR?",
              "What evidence will make the first handoff acceptable?",
            ],
          },
        }
      : {}),
    next: created
      ? [
          "Begin the skeleton grill immediately.",
          "Create server documents only as decisions crystallize.",
        ]
      : [
          "Read every pulled document and every work thread.",
          "Answer unanswered questions addressed to your identifier first.",
          "Run ao watch --project --once to begin the self-driven loop.",
        ],
  };
}

function roomLabel(room, index) {
  const expected = room.expected_participant
    ? `${room.expected_participant.identifier} (${room.expected_participant.role})`
    : "undeclared";
  const presence = room.presence?.present ? "present" : "absent";
  const heartbeat = room.presence?.last_heartbeat_at ?? "none";
  const ball = room.presence?.ball?.has_ball ?? false;
  const abandoned = room.presence?.abandoned ?? false;
  return `${index + 1}. ${room.project.slug} / ${room.work.slug}  ${room.work.title}  slot=${expected} presence=${presence} heartbeat=${heartbeat} ball=${ball} abandoned=${abandoned} state=${room.work.state}`;
}

async function roomsCommand(parsed) {
  const listing = await fetchRooms(parsed);
  if (hasOption(parsed, "json")) {
    print(listing);
    return;
  }
  if (listing.rooms.length === 0) {
    console.log("No chat rooms are available.");
    return;
  }
  console.log("Available chat rooms:");
  listing.rooms.forEach((room, index) => console.log(roomLabel(room, index)));
  console.log(
    "Choose one room number. Choosing a present room confirms that you saw the duplicate-participant warning.",
  );
}

function selectRoom(rooms, selection) {
  if (/^\d+$/.test(selection)) {
    const index = Number(selection) - 1;
    if (index < 0 || index >= rooms.length) {
      throw new CliError(
        `Room number ${selection} is out of range; choose 1-${rooms.length}`,
        2,
      );
    }
    return rooms[index];
  }
  const separator = selection.indexOf("/");
  if (separator > 0) {
    const project = selection.slice(0, separator);
    const work = selection.slice(separator + 1);
    const room = rooms.find(
      (candidate) =>
        candidate.project.slug === project && candidate.work.slug === work,
    );
    if (room) {
      return room;
    }
  }
  throw new CliError(
    `Unknown room ${selection}; use its list number or PROJECT/WORK`,
    2,
  );
}

async function joinRoom(parsed) {
  const selection = parsed.positional[1];
  if (!selection) {
    throw new CliError("join requires a room number or PROJECT/WORK");
  }
  const repository = resolve(String(option(parsed, "repo", process.cwd())));
  if (!existsSync(repository) || !statSync(repository).isDirectory()) {
    throw new CliError(`Repository directory not found: ${repository}`);
  }

  const listing = await fetchRooms(parsed);
  const room = selectRoom(listing.rooms, String(selection));
  const expected = room.expected_participant;
  let identity;
  try {
    identity = resolveIdentity(parsed, {}, {
      defaults: {
        identifier: expected?.identifier,
        role: expected?.role ?? "implementer",
      },
    });
  } catch (error) {
    if (
      error instanceof CliError &&
      error.message.startsWith("Cannot resolve the participant identifier")
    ) {
      throw new CliError(
        `Room ${room.project.slug}/${room.work.slug} has no implementer slot. Ask the owner for an identifier, then repeat with --identifier ID.`,
        2,
      );
    }
    throw error;
  }
  const identifier = identity.identifier;
  const role = identity.role;
  if (!identifier) {
    throw new CliError(
      `Room ${room.project.slug}/${room.work.slug} has no implementer slot. Ask the owner for an identifier, then repeat with --identifier ID.`,
      2,
    );
  }
  const occupyingExpectedSlot =
    expected?.identifier === identifier && room.presence?.present;
  if (occupyingExpectedSlot && !hasOption(parsed, "confirm-occupied")) {
    throw new CliError(
      `WARNING: ${identifier} is already present in ${room.project.slug}/${room.work.slug} (heartbeat ${room.presence.last_heartbeat_at}). Two processes using one identifier corrupt heartbeat and abandonment state. Confirm with the owner, then repeat with --confirm-occupied.`,
      2,
    );
  }

  const config = {
    server_url: listing.server.server_url,
    project: room.project.slug,
    work: room.work.slug,
    identifier,
    role,
    cli: {
      command: process.execPath,
      args: [CLI_ENTRYPOINT],
    },
  };
  const configPath = join(repository, ".ao", "config.json");
  const existingConfig = readJson(configPath, {});
  warnIdentityOverwrite("join", configPath, existingConfig, identity);
  mkdirSync(join(repository, ".ao", "docs"), { recursive: true });
  writeJson(configPath, config);
  const context = {
    config,
    configPath,
    repository,
    statePath: join(repository, ".ao", "state.json"),
  };
  const skills = installSkills(repository);
  ensureIgnored(repository);
  const documents = await pullDocuments(
    context,
    undefined,
    hasOption(parsed, "force"),
  );
  const thread = await pollWork(context, room.work.slug, {
    heartbeat: true,
    since: 0,
  });
  return {
    room,
    config: {
      ...config,
      server_source: listing.server.source,
    },
    documents: documents.map(({ doc, revision }) => ({
      doc,
      path: relative(repository, documentPath(repository, doc)),
      revision,
    })),
    messages: thread.messages,
    your_ball: thread.your_ball,
    idle_nudge: thread.idle_nudge,
    abandoned: thread.abandoned,
    stale_expectations: thread.stale_expectations,
    skills,
    next: [
      "Read every pulled document and message in this output.",
      "Answer unanswered questions addressed to your identifier first.",
      "Run ao watch --once to begin the self-driven loop.",
      "Post a status start message to the thread.",
    ],
  };
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
  const mode = statSync(source).mode & 0o777;
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === content) {
      chmodSync(target, mode);
      return { action: "unchanged", target };
    }
    const backup = backupPath(target);
    copyFileSync(target, backup);
    atomicWrite(target, content);
    chmodSync(target, mode);
    return { action: "backed-up", backup, target };
  }
  atomicWrite(target, content);
  chmodSync(target, mode);
  return { action: "created", target };
}

function skillFiles(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...skillFiles(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path));
    }
  }
  return files;
}

function installSkills(repository) {
  const results = [];
  for (const name of readdirSync(TEMPLATE_ROOT)) {
    const sourceRoot = join(TEMPLATE_ROOT, name);
    if (!statSync(sourceRoot).isDirectory()) {
      continue;
    }
    for (const file of skillFiles(sourceRoot)) {
      for (const root of [".claude", ".agents"]) {
        results.push(
          installSkillFile(
            join(sourceRoot, file),
            join(repository, root, "skills", name, file),
          ),
        );
      }
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
  const messages = [];
  const errors = [];
  lines.forEach((line, index) => {
    try {
      const message = JSON.parse(line);
      messages.push(message);
      if (message && typeof message === "object" && !Array.isArray(message)) {
        for (const field of ["ts", "closed_at"]) {
          if (
            message[field] &&
            Number.isNaN(new Date(message[field]).getTime())
          ) {
            errors.push({
              path,
              line: index + 1,
              id: typeof message.id === "string" ? message.id : null,
              field,
              value: message[field],
              message: `Invalid timestamp: ${message[field]}`,
            });
          }
        }
      }
    } catch (error) {
      errors.push({
        path,
        line: index + 1,
        id: null,
        field: null,
        value: null,
        message: error.message,
      });
    }
  });
  return { errors, messages };
}

function buildImportBundle(source, context, parsed) {
  const documents = [];
  const works = new Map();
  const sessions = [];
  const sessionValidationErrors = [];
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
      const parsedSession = readSession(join(sessionDirectory, name));
      sessionValidationErrors.push(...parsedSession.errors);
      sessions.push({
        messages: parsedSession.messages,
        title: works.get(workSlug)?.title ?? workSlug,
        work_slug: workSlug,
      });
      if (!works.has(workSlug)) {
        works.set(workSlug, { slug: workSlug, state: "open", title: workSlug });
      }
    }
  }
  if (sessionValidationErrors.length > 0) {
    throw new CliError(
      `Import validation failed for ${sessionValidationErrors.length} source field(s); no request was sent:\n${sessionValidationErrors
        .map((error) =>
          error.field
            ? `- ${error.path}:${error.line} id=${error.id ?? "unknown"} field=${error.field} value=${JSON.stringify(error.value)} ${error.message}`
            : `- ${error.path}:${error.line} is not valid JSON: ${error.message}`,
        )
        .join("\n")}`,
    );
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
  const configPath = join(repository, ".ao", "config.json");
  const existingConfig = readJson(configPath, {});
  const identity = resolveIdentity(parsed, existingConfig);
  let serverUrl = option(parsed, "server");
  if (serverUrl === undefined) {
    try {
      serverUrl = resolveServerUrl(parsed).server_url;
    } catch {
      serverUrl = "http://127.0.0.1:7331";
    }
  }
  const config = {
    server_url: String(serverUrl),
    project: String(project),
    identifier: identity.identifier,
    role: identity.role,
    cli: {
      command: process.execPath,
      args: [CLI_ENTRYPOINT],
    },
    ...(selectedWork ? { work: String(selectedWork) } : {}),
  };
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

  warnIdentityOverwrite("inject", configPath, existingConfig, identity);
  mkdirSync(join(repository, ".ao", "docs"), { recursive: true });
  writeJson(configPath, config);
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

function emitPoll(result, prefix = "") {
  for (const message of result.messages) {
    console.log(`${prefix}${messageLine(message)}`);
  }
  if (result.idle_nudge) {
    console.log(`${prefix}IDLE ${result.idle_nudge}`);
  }
  for (const participant of result.abandoned) {
    console.log(
      `${prefix}ABANDONED identifier=${participant.identifier} last_heartbeat_at=${participant.last_heartbeat_at ?? "never"} reasons=${JSON.stringify(participant.ball_reasons)}`,
    );
  }
  for (const expectation of result.stale_expectations) {
    console.log(
      `${prefix}STALE doc=${expectation.doc} you_have=${expectation.you_have} current=${expectation.current}`,
    );
  }
  if (result.your_ball.has_ball) {
    console.log(
      `${prefix}BALL reasons=${JSON.stringify(result.your_ball.reasons)}`,
    );
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
      const result = await pollWork(context, work, {
        heartbeat: once,
        since,
      });
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

async function watchProject(context, parsed) {
  const once = hasOption(parsed, "once");
  const interval = Number(option(parsed, "interval", 10)) * 1_000;
  if (!Number.isFinite(interval) || interval < 10) {
    throw new CliError("--interval must be at least 0.01 seconds");
  }
  const explicitSince = option(parsed, "since");
  if (
    explicitSince !== undefined &&
    (!Number.isInteger(Number(explicitSince)) || Number(explicitSince) < 0)
  ) {
    throw new CliError("--since must be a non-negative integer");
  }
  let failures = 0;
  while (true) {
    try {
      const project = await api(
        context.config,
        "GET",
        `/projects/${apiPath(context.config.project)}`,
      );
      const state = readJson(context.statePath, { documents: {} });
      state.project_messages ??= {};
      const results = await Promise.all(
        project.works.map(async (work) => {
          const since =
            explicitSince === undefined
              ? state.project_messages[work.slug] ?? 0
              : Number(explicitSince);
          return {
            work,
            result: await pollWork(context, work.slug, {
              heartbeat: once,
              since,
            }),
          };
        }),
      );
      if (results.length === 0) {
        console.log(
          `PROJECT project=${context.config.project} works=0 skeleton_grill=true`,
        );
      }
      for (const { work, result } of results) {
        console.log(
          `PROJECT_WORK project=${context.config.project} work=${work.slug} heartbeat=${result.heartbeat_at ?? "none"} ball=${result.your_ball.has_ball} idle=${result.idle_nudge !== null} abandoned=${result.abandoned.length}`,
        );
        emitPoll(
          result,
          `WORK project=${context.config.project} work=${work.slug} `,
        );
        if (result.messages.length > 0 && explicitSince === undefined) {
          state.project_messages[work.slug] = result.messages.at(-1).seq;
        }
      }
      writeJson(context.statePath, state);
      failures = 0;
    } catch (error) {
      failures += 1;
      console.error(
        `ERROR project watch failure=${failures} ${error.displayMessage ?? error.message}`,
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
  assertKnownOptions(command, parsed);

  if (command === "inject") {
    print(await inject(parsed));
    return;
  }
  if (command === "configure") {
    print(configure(parsed));
    return;
  }
  if (command === "projects") {
    await projectsCommand(parsed);
    return;
  }
  if (command === "design") {
    const result = await designProject(parsed);
    if (result !== null) {
      print(result);
    }
    return;
  }
  if (command === "rooms") {
    await roomsCommand(parsed);
    return;
  }
  if (command === "join") {
    print(await joinRoom(parsed));
    return;
  }
  if (command === "delete-project") {
    print(await deleteProjectCommand(parsed));
    return;
  }
  if (command === "delete-work") {
    print(await deleteWorkCommand(parsed));
    return;
  }
  if (command === "delete-participant") {
    print(await deleteParticipantCommand(parsed));
    return;
  }

  const context = loadContext(parsed);
  if (command === "issue-create") {
    print(await issueCreateCommand(context, parsed));
    return;
  }
  if (command === "issues") {
    print(await issuesCommand(context, parsed));
    return;
  }
  if (command === "issue") {
    print(await issueDetailCommand(context, parsed));
    return;
  }
  if (command === "issue-comment") {
    print(await issueCommentCommand(context, parsed));
    return;
  }
  if (command === "issue-close") {
    print(await issueCloseCommand(context, parsed));
    return;
  }
  if (command === "issue-reopen") {
    print(await issueReopenCommand(context, parsed));
    return;
  }
  if (command === "pull") {
    await activeHeartbeat(context, parsed);
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
    await activeHeartbeat(context, parsed);
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
    if (!Number.isInteger(since) || since < 0) {
      throw new CliError("--since must be a non-negative integer");
    }
    const result = await pollWork(context, work, { since });
    for (const message of result.messages) {
      console.log(messageLine(message));
    }
    return;
  }
  if (command === "watch") {
    if (hasOption(parsed, "project")) {
      await watchProject(context, parsed);
    } else {
      await watch(context, parsed);
    }
    return;
  }
  if (command === "close") {
    const work = requireWork(context, parsed);
    const seq = Number(parsed.positional[1]);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new CliError("close requires a positive message sequence");
    }
    await pollWork(context, work);
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
    await pollWork(context, work);
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
        {
          slug,
          title: requireOption(parsed, "title"),
          ...(hasOption(parsed, "implementer")
            ? { implementer: requireOption(parsed, "implementer") }
            : {}),
        },
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
  projectSlug,
  resolveIdentity,
  resolveServerUrl,
  selectRoom,
  stripCopyHeader,
  userConfigPath,
};
