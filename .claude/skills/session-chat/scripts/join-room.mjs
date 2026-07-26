#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cliInvocation } from "./lib/ao-cli.mjs";

const args = process.argv.slice(2);
const snapshotPath = join(process.cwd(), ".ao", "room-selection.json");

if (args.length === 0) {
  const [command, commandArgs] = cliInvocation(
    ["rooms", "--json"],
    "join-room",
  );
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    env: process.env,
  });
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    console.error(`join-room: cannot start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.exit(result.status ?? 1);
  }
  let listing;
  try {
    listing = JSON.parse(result.stdout);
  } catch (error) {
    console.error(`join-room: ao rooms returned invalid JSON: ${error.message}`);
    process.exit(1);
  }
  mkdirSync(join(process.cwd(), ".ao"), { recursive: true });
  writeFileSync(snapshotPath, `${JSON.stringify(listing, null, 2)}\n`, "utf8");
  if (listing.rooms.length === 0) {
    console.log("No chat rooms are available.");
    process.exit(0);
  }
  console.log("Available chat rooms:");
  listing.rooms.forEach((room, index) => {
    const expected = room.expected_participant
      ? `${room.expected_participant.identifier} (${room.expected_participant.role})`
      : "undeclared";
    const presence = room.presence?.present ? "present" : "absent";
    const heartbeat = room.presence?.last_heartbeat_at ?? "none";
    const ball = room.presence?.ball?.has_ball ?? false;
    const abandoned = room.presence?.abandoned ?? false;
    console.log(
      `${index + 1}. ${room.project.slug} / ${room.work.slug}  ${room.work.title}  slot=${expected} presence=${presence} heartbeat=${heartbeat} ball=${ball} abandoned=${abandoned} state=${room.work.state}`,
    );
  });
  console.log(
    "Choose one room number. Choosing a present room confirms that you saw the duplicate-participant warning.",
  );
  process.exit(0);
}

let selection = args[0];
if (/^\d+$/.test(selection) && existsSync(snapshotPath)) {
  let listing;
  try {
    listing = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch (error) {
    console.error(
      `join-room: cannot read the saved room list ${snapshotPath}: ${error.message}`,
    );
    process.exit(1);
  }
  const room = listing.rooms?.[Number(selection) - 1];
  if (!room) {
    console.error(
      `join-room: room number ${selection} is not in the saved room list`,
    );
    process.exit(2);
  }
  selection = `${room.project.slug}/${room.work.slug}`;
}

const cliArgs = [
  "join",
  selection,
  "--confirm-occupied",
  ...args.slice(1),
];
const [command, commandArgs] = cliInvocation(cliArgs, "join-room");
const result = spawnSync(command, commandArgs, {
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  console.error(`join-room: cannot start ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
