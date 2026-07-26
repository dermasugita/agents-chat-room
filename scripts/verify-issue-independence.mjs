import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "ao-issue-realtime-"));
let serverProcess;

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function request(base, method, path, body = undefined) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(
    response.ok,
    true,
    `${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`,
  );
  return payload;
}

async function waitForHealth(base, diagnostics) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`server exited early: ${diagnostics()}`);
    }
    try {
      await request(base, "GET", "/api/v1/health");
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw new Error(`server did not become healthy: ${diagnostics()}`);
}

function waitUntil(timestamp) {
  return new Promise((resolveDelay) => {
    const delay = Math.max(0, timestamp - Date.now());
    setTimeout(resolveDelay, delay);
  });
}

function comparablePoll(result) {
  return {
    your_ball: result.your_ball,
    idle_nudge: result.idle_nudge,
    abandoned: result.abandoned,
  };
}

try {
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";
  serverProcess = spawn(process.execPath, ["src/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      AO_BIND: "127.0.0.1",
      AO_PORT: String(port),
      AO_DATABASE_PATH: join(directory, "realtime.sqlite"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  serverProcess.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const diagnostics = () => `${stdout}\n${stderr}`.trim();
  await waitForHealth(base, diagnostics);

  for (const [slug, name] of [
    ["realtime-source", "Realtime source"],
    ["realtime-target", "Realtime target"],
  ]) {
    await request(base, "POST", "/api/v1/projects", { slug, name });
    await request(base, "POST", `/api/v1/projects/${slug}/works`, {
      slug: "idle-check",
      title: "Idle check",
    });
  }

  const poll = (project) =>
    request(
      base,
      "GET",
      `/api/v1/projects/${project}/works/idle-check/poll?as=realtime-observer&role=implementer`,
    );
  const baselineControl = await poll("realtime-source");
  const baselineTarget = await poll("realtime-target");
  assert.deepEqual(
    comparablePoll(baselineTarget),
    comparablePoll(baselineControl),
  );

  const issue = await request(
    base,
    "POST",
    "/api/v1/projects/realtime-target/issues",
    {
      title: "Long-lived backlog item",
      body: "This open issue must not affect work attention state.",
      origin_project: "realtime-source",
      origin_identifier: "realtime-impl",
      origin_role: "implementer",
      origin_work: "idle-check",
    },
  );
  assert.equal(issue.state, "open");
  const startedAt = Date.now();
  console.log(
    JSON.stringify({
      event: "started",
      at: new Date(startedAt).toISOString(),
      pid: serverProcess.pid,
      issue: `${issue.project}#${issue.number}`,
    }),
  );

  for (let minute = 1; minute <= 3; minute += 1) {
    await waitUntil(startedAt + minute * 60_000);
    const [control, target] = await Promise.all([
      poll("realtime-source"),
      poll("realtime-target"),
    ]);
    assert.deepEqual(comparablePoll(target), comparablePoll(control));
    assert.equal(target.your_ball.has_ball, false);
    assert.deepEqual(target.abandoned, []);
    console.log(
      JSON.stringify({
        event: minute === 3 ? "after_3m" : "heartbeat",
        elapsed_ms: Date.now() - startedAt,
        minute,
        target: comparablePoll(target),
      }),
    );
  }

  for (let minute = 4; minute <= 5; minute += 1) {
    await waitUntil(startedAt + minute * 60_000 + (minute === 5 ? 2_000 : 0));
    const [control, target] = await Promise.all([
      poll("realtime-source"),
      poll("realtime-target"),
    ]);
    assert.deepEqual(comparablePoll(target), comparablePoll(control));
    assert.equal(target.your_ball.has_ball, false);
    assert.deepEqual(target.abandoned, []);
    if (minute === 5) {
      assert.match(target.idle_nudge, /5 minutes/);
    }
    console.log(
      JSON.stringify({
        event: minute === 5 ? "after_5m" : "heartbeat",
        elapsed_ms: Date.now() - startedAt,
        minute,
        target: comparablePoll(target),
      }),
    );
  }

  const openIssues = await request(
    base,
    "GET",
    "/api/v1/projects/realtime-target/issues",
  );
  assert.deepEqual(
    openIssues.issues.map(({ number, state }) => ({ number, state })),
    [{ number: 1, state: "open" }],
  );
  console.log(
    JSON.stringify({
      event: "passed",
      elapsed_ms: Date.now() - startedAt,
      issue_state: openIssues.issues[0].state,
    }),
  );
} finally {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
  }
  rmSync(directory, { recursive: true, force: true });
}
