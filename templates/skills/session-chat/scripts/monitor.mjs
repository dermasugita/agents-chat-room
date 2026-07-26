#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cliInvocation } from "./lib/ao-cli.mjs";

const mode = process.argv[2];
const extra = process.argv.slice(3);
const modes = {
  designer: ["watch", "--project", "--once"],
  implementer: ["watch", "--once"],
};
if (!Object.hasOwn(modes, mode)) {
  console.error("monitor: expected designer or implementer");
  process.exit(64);
}

const label = `${mode}-monitor`;
const [command, args] = cliInvocation([...modes[mode], ...extra], label);
const result = spawnSync(command, args, { stdio: "inherit" });
if (result.error) {
  console.error(`${label}: cannot start ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
