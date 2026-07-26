#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cliInvocation } from "./lib/ao-cli.mjs";

function run(command, args) {
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`self-driven-loop: cannot start ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0 || separator === args.length - 1) {
  console.error(
    "Usage: self-driven-loop.mjs [--cycles N] -- <one-bounded-work-command> [args...]",
  );
  process.exit(64);
}
const options = args.slice(0, separator);
const workCommand = args[separator + 1];
const workArgs = args.slice(separator + 2);
let cycles = 1;
if (options.length > 0) {
  if (
    options.length !== 2 ||
    options[0] !== "--cycles" ||
    !/^[1-9]\d*$/.test(options[1])
  ) {
    console.error("self-driven-loop: --cycles must be a positive integer");
    process.exit(64);
  }
  cycles = Number(options[1]);
}

for (let cycle = 1; cycle <= cycles; cycle += 1) {
  console.error(`self-driven-loop: work unit ${cycle}/${cycles}`);
  const workStatus = run(workCommand, workArgs);
  if (workStatus !== 0) {
    process.exit(workStatus);
  }

  console.error("self-driven-loop: active thread check");
  const [aoCommand, aoArgs] = cliInvocation(
    ["watch", "--once"],
    "self-driven-loop",
  );
  const watchStatus = run(aoCommand, aoArgs);
  if (watchStatus !== 0) {
    process.exit(watchStatus);
  }
}

console.error(
  "self-driven-loop: cycle complete; process new events, inspect your ball, then invoke the next bounded cycle",
);
