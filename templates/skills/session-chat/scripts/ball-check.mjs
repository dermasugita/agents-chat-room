#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cliInvocation } from "./lib/ao-cli.mjs";

const [command, commandArgs] = cliInvocation(
  ["watch", "--once", ...process.argv.slice(2)],
  "ball-check",
);
const result = spawnSync(command, commandArgs, {
  encoding: "utf8",
  env: process.env,
});
if (result.error) {
  console.error(`ball-check: cannot start ${command}: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
}

const lines = (result.stdout ?? "").split(/\r?\n/).filter(Boolean);
const ball = lines.find((line) => line.startsWith("BALL "));
const idle = lines.some((line) => line.startsWith("IDLE "));
const reasons = ball?.match(/^BALL reasons=(.*)$/)?.[1] ?? "[]";
console.log(
  `BALL has_ball=${Boolean(ball)} idle=${idle} reasons=${reasons}`,
);
