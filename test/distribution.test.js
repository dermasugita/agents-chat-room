import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { listen } from "../src/server.js";

test("direct startup defaults to the IPv4 loopback interface", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ao-bind-test-"));
  const originalLog = console.log;
  console.log = () => {};
  let application;
  try {
    application = await listen({
      databasePath: join(directory, "bind.sqlite"),
      port: 0,
    });
    assert.equal(application.server.address().address, "127.0.0.1");
  } finally {
    console.log = originalLog;
    if (application) {
      await new Promise((resolveClose) =>
        application.server.close(resolveClose),
      );
      application.database.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Docker distribution fixes host publication to loopback", () => {
  const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
  const compose = readFileSync(resolve("compose.yaml"), "utf8");
  const readme = readFileSync(resolve("README.md"), "utf8");
  assert.match(dockerfile, /AO_BIND=0\.0\.0\.0/);
  assert.match(compose, /host_ip:\s*127\.0\.0\.1/);
  assert.match(readme, /--publish 127\.0\.0\.1:7331:7331/);
  for (const content of [dockerfile, compose, readme]) {
    assert.doesNotMatch(content, /(?:--publish|-p)\s+\d+:\d+/);
  }
});

test("CLI package declares the measured minimum Node version", () => {
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.equal(packageJson.engines.node, ">=22.14.0");
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.bin.ao, "bin/ao.js");
});
