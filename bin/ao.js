#!/usr/bin/env node

import { main } from "../src/cli.js";

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error?.displayMessage) {
    console.error(error.displayMessage);
  } else {
    console.error(error);
  }
  process.exit(error?.exitCode ?? 1);
}
