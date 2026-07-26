#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cliInvocation } from "./lib/ao-cli.mjs";

const args = process.argv.slice(2);
if (args.some((argument) => argument === "--once" || argument.startsWith("--once="))) {
  console.error(
    "watch-passive: --once is active attention; run `ao watch --once` directly",
  );
  process.exit(64);
}

const [command, commandArgs] = cliInvocation(
  ["watch", ...args],
  "watch-passive",
);
const child = spawn(command, commandArgs, {
  env: process.env,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`watch-passive: cannot start ${command}: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    child.kill(signal);
  });
}
