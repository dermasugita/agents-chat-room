#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const options = {
  destination: join(
    homedir(),
    ".local",
    "share",
    "agents-chat-room-cli",
  ),
};

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--help") {
    console.log(
      "Usage: install-cli.mjs [--destination ABSOLUTE_PATH]",
    );
    process.exit(0);
  }
  const match = argument.match(/^--destination(?:=(.*))?$/);
  if (!match) {
    console.error(`install-cli: unknown argument: ${argument}`);
    process.exit(64);
  }
  const value = match[1] ?? args[++index];
  if (!value || value.startsWith("--")) {
    console.error("install-cli: --destination requires a value");
    process.exit(64);
  }
  options.destination = value;
}

if (!isAbsolute(options.destination)) {
  console.error("install-cli: --destination must be an absolute path");
  process.exit(64);
}
options.destination = resolve(options.destination);
const destinationFromRepository = relative(repository, options.destination);
if (
  destinationFromRepository === "" ||
  (
    destinationFromRepository !== ".." &&
    !destinationFromRepository.startsWith(`..${sep}`) &&
    !isAbsolute(destinationFromRepository)
  )
) {
  console.error(
    "install-cli: destination must be outside the source repository",
  );
  process.exit(64);
}

function copyRuntime(destination) {
  const packageJson = JSON.parse(
    readFileSync(join(repository, "package.json"), "utf8"),
  );
  const runtimeEntries = ["package.json", ...packageJson.files];
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const entry of runtimeEntries) {
    const normalized = entry.replace(/\/+$/, "");
    const source = join(repository, normalized);
    if (!existsSync(source)) {
      throw new Error(`required runtime entry is missing: ${normalized}`);
    }
    cpSync(source, join(destination, normalized), {
      recursive: true,
      preserveTimestamps: true,
    });
  }
  for (const required of [
    "bin/ao.js",
    "src/cli.js",
    "src/server.js",
    "templates/skills/session-chat/SKILL.md",
    "templates/skills/session-chat/scripts/join-room.mjs",
  ]) {
    if (!existsSync(join(destination, required))) {
      throw new Error(`installed runtime entry is missing: ${required}`);
    }
  }
}

async function runInstalled(cliPath, cliArgs, cwd, environment) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [cliPath, ...cliArgs],
      {
        cwd,
        env: environment,
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
      },
    );
    return result.stdout;
  } catch (error) {
    throw new Error(
      `${cliArgs[0]} smoke test failed: ${
        error.stderr?.trim() || error.message
      }`,
    );
  }
}

async function smokeInstalledCli(destination) {
  const smokeRoot = mkdtempSync(
    join(tmpdir(), "agents-chat-room-cli-smoke-"),
  );
  const plainDirectory = join(smokeRoot, "plain");
  const repositoryDirectory = join(smokeRoot, "repository");
  const isolatedHome = join(smokeRoot, "home");
  mkdirSync(plainDirectory);
  mkdirSync(repositoryDirectory);
  mkdirSync(isolatedHome);

  let application;
  try {
    const serverModule = await import(
      `${pathToFileURL(join(destination, "src", "server.js")).href}?smoke=${randomUUID()}`
    );
    application = serverModule.createHttpServer({
      databasePath: join(smokeRoot, "smoke.sqlite"),
    });
    application.store.createProject({
      slug: "install-smoke",
      name: "CLI installation smoke test",
    });
    application.store.createWork("install-smoke", {
      slug: "join-check",
      title: "Join check",
      implementer: "install-smoke",
    });
    application.store.createDocument("install-smoke", {
      kind: "context",
      title: "Smoke context",
      body: "# Smoke context\n",
      author: "installer",
    });
    await new Promise((resolveListen, rejectListen) => {
      application.server.once("error", rejectListen);
      application.server.listen(0, "127.0.0.1", resolveListen);
    });
    const serverUrl =
      `http://127.0.0.1:${application.server.address().port}`;
    const cliPath = join(destination, "bin", "ao.js");
    const environment = {
      ...process.env,
      HOME: isolatedHome,
      AO_SERVER_URL: serverUrl,
      AO_IDENTIFIER: "",
      AO_ROLE: "",
    };

    const rooms = JSON.parse(
      await runInstalled(
        cliPath,
        ["rooms", "--json"],
        plainDirectory,
        environment,
      ),
    );
    if (
      rooms.rooms?.length !== 1 ||
      rooms.rooms[0].work?.slug !== "join-check"
    ) {
      throw new Error("rooms smoke test returned the wrong room");
    }

    const joined = JSON.parse(
      await runInstalled(
        cliPath,
        [
          "join",
          "install-smoke/join-check",
          "--repo",
          repositoryDirectory,
          "--identifier",
          "install-smoke",
          "--role",
          "implementer",
        ],
        plainDirectory,
        environment,
      ),
    );
    const recordedCliPath = joined.config?.cli?.args?.[0];
    if (
      typeof recordedCliPath !== "string" ||
      realpathSync(recordedCliPath) !== realpathSync(cliPath)
    ) {
      throw new Error("join did not record the installed CLI path");
    }
    for (const installedSkill of [
      ".agents/skills/session-chat/SKILL.md",
      ".claude/skills/session-chat/SKILL.md",
    ]) {
      if (!existsSync(join(repositoryDirectory, installedSkill))) {
        throw new Error(`join did not install ${installedSkill}`);
      }
    }
    return {
      rooms: rooms.rooms.length,
      joined: `${joined.room.project.slug}/${joined.room.work.slug}`,
      cli_path: recordedCliPath,
    };
  } finally {
    if (application) {
      await new Promise((resolveClose) => {
        application.server.close(resolveClose);
        application.server.closeAllConnections();
      });
      application.database.close();
    }
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

const suffix = `${process.pid}-${randomUUID()}`;
const staging = `${options.destination}.installing-${suffix}`;
const backup = `${options.destination}.previous-${suffix}`;
let destinationReplaced = false;
let previousMoved = false;

try {
  mkdirSync(dirname(options.destination), { recursive: true, mode: 0o755 });
  copyRuntime(staging);
  if (existsSync(options.destination)) {
    renameSync(options.destination, backup);
    previousMoved = true;
  }
  renameSync(staging, options.destination);
  destinationReplaced = true;
  const smoke = await smokeInstalledCli(options.destination);
  if (previousMoved) {
    rmSync(backup, { recursive: true, force: true });
    previousMoved = false;
  }
  console.log(
    JSON.stringify({
      installed: options.destination,
      smoke,
    }),
  );
} catch (error) {
  if (destinationReplaced && existsSync(options.destination)) {
    rmSync(options.destination, { recursive: true, force: true });
  }
  if (previousMoved && existsSync(backup)) {
    renameSync(backup, options.destination);
    previousMoved = false;
  }
  console.error(`install-cli: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (existsSync(staging)) {
    rmSync(staging, { recursive: true, force: true });
  }
  if (existsSync(backup)) {
    rmSync(backup, { recursive: true, force: true });
  }
}
