#!/usr/bin/env node

import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  if (error?.displayMessage) {
    console.error(error.displayMessage);
  } else {
    console.error(error);
  }
  process.exitCode = error?.exitCode ?? 1;
});
