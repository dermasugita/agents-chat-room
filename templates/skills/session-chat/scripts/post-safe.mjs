#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === `--${name}`) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        values.push(value);
        index += 1;
      } else {
        values.push("");
      }
    } else if (token.startsWith(`--${name}=`)) {
      values.push(token.slice(name.length + 3));
    }
  }
  return values;
}

function fail(message) {
  console.error(`post-safe: ${message}; request was not sent`);
  process.exit(64);
}

function cliInvocation(args) {
  const configured = process.env.AO_CLI ?? "ao";
  if (configured.endsWith(".js") || configured.endsWith(".mjs")) {
    return [process.execPath, [configured, ...args]];
  }
  return [configured, args];
}

const args = process.argv.slice(2);
const type = optionValues(args, "type").at(-1);
const recipients = optionValues(args, "to")
  .flatMap((value) => value.split(","))
  .map((value) => value.trim())
  .filter(Boolean);
const replyTo = optionValues(args, "reply-to").at(-1);

if (type === "answer" && !/^[1-9]\d*$/.test(replyTo ?? "")) {
  fail("answer requires a positive --reply-to");
}
if (type === "question" && recipients.length === 0) {
  fail("question requires at least one --to recipient");
}

const [command, commandArgs] = cliInvocation(["post", ...args]);
const result = spawnSync(command, commandArgs, {
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  console.error(`post-safe: cannot start ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
