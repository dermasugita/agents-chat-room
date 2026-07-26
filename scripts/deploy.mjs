#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = {
  image: "agents-chat-room:0.1.0",
  name: "agents-chat-room",
  port: "7331",
  volume: "agents-chat-room-data",
  dryRun: false,
  skipBuild: false,
};

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--dry-run") {
    options.dryRun = true;
    continue;
  }
  if (argument === "--skip-build") {
    options.skipBuild = true;
    continue;
  }
  const match = argument.match(/^--(image|name|port|volume)(?:=(.*))?$/);
  if (!match) {
    console.error(`deploy: unknown argument: ${argument}`);
    process.exit(64);
  }
  const value = match[2] ?? args[++index];
  if (!value || value.startsWith("--")) {
    console.error(`deploy: --${match[1]} requires a value`);
    process.exit(64);
  }
  options[match[1]] = value;
}

if (!/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535) {
  console.error("deploy: --port must be an integer from 1 to 65535");
  process.exit(64);
}
for (const [name, value] of [
  ["name", options.name],
  ["volume", options.volume],
]) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) {
    console.error(`deploy: --${name} contains unsupported characters`);
    process.exit(64);
  }
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(options.image)) {
  console.error("deploy: --image contains unsupported characters");
  process.exit(64);
}

function run(commandArgs) {
  console.log(JSON.stringify(["docker", ...commandArgs]));
  if (options.dryRun) {
    return;
  }
  const result = spawnSync("docker", commandArgs, {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`deploy: cannot start docker: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!options.skipBuild) {
  run(["build", "--platform", "linux/amd64", "--tag", options.image, repository]);
}
run(["volume", "create", options.volume]);
run([
  "run",
  "--detach",
  "--name",
  options.name,
  "--restart",
  "unless-stopped",
  "--platform",
  "linux/amd64",
  "--publish",
  `127.0.0.1:${options.port}:7331`,
  "--volume",
  `${options.volume}:/data`,
  options.image,
]);
