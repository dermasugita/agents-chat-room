#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cliInvocation } from "../../session-chat/scripts/lib/ao-cli.mjs";

const args = process.argv.slice(2);
const cliArgs =
  args.length === 0
    ? ["projects"]
    : ["design", args[0], "--repo", ".", ...args.slice(1)];
const [command, commandArgs] = cliInvocation(cliArgs, "designer-start");
const result = spawnSync(command, commandArgs, {
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  console.error(
    `designer-start: cannot start ${command}: ${result.error.message}`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
