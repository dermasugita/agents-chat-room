import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createDatabase, getDatabasePragmas } from "../src/db.js";
import { createHttpServer } from "../src/server.js";
import { createStore } from "../src/store.js";

let temporaryDirectory;
let database;
let store;
let currentTime;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "ao-test-"));
  currentTime = new Date("2026-07-26T00:00:00.000Z");
  database = createDatabase(join(temporaryDirectory, "test.sqlite"));
  store = createStore(database, { clock: () => new Date(currentTime) });
  store.createProject({ slug: "sample", name: "Sample" });
  store.createWork("sample", { slug: "work-one", title: "Work one" });
});

afterEach(() => {
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function post(work, overrides = {}) {
  return store.postMessage("sample", work, {
    idempotency_key: crypto.randomUUID(),
    from: "designer",
    role: "designer",
    type: "message",
    body: "body",
    to: [],
    refs: [],
    ...overrides,
  });
}

async function withServer(operation) {
  const application = createHttpServer({ store, database });
  await new Promise((resolve) =>
    application.server.listen(0, "127.0.0.1", resolve),
  );
  const address = application.server.address();
  try {
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => application.server.close(resolve));
  }
}

async function request(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { body: await response.json(), status: response.status };
}

test("database connections enforce WAL, foreign keys, and busy timeout", () => {
  assert.deepEqual(getDatabasePragmas(database), {
    busy_timeout: 5000,
    foreign_keys: 1,
    journal_mode: "wal",
  });
});

test("schema version 1 migrates expected-participant columns without losing work", () => {
  const path = join(temporaryDirectory, "schema-v1.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL, migrated_at TEXT NOT NULL);
    INSERT INTO schema_meta VALUES (1, '2026-07-25T00:00:00.000Z');
    CREATE TABLE project(
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE work(
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES project(id),
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, slug)
    );
    INSERT INTO project VALUES (1, 'legacy', 'Legacy', '2026-07-25T00:00:00.000Z');
    INSERT INTO work VALUES (
      1, 1, 'kept-work', 'Kept work', 'open', '2026-07-25T00:00:00.000Z'
    );
  `);
  legacy.close();

  const migrated = createDatabase(path);
  assert.equal(
    migrated.prepare("SELECT MAX(version) AS version FROM schema_meta").get().version,
    2,
  );
  assert.deepEqual(
    {
      ...migrated
        .prepare(
          `SELECT slug, expected_participant_identifier,
                  expected_participant_role
           FROM work`,
        )
        .get(),
    },
    {
      slug: "kept-work",
      expected_participant_identifier: null,
      expected_participant_role: null,
    },
  );
  migrated.close();
});

test("room listing exposes the expected implementer and independent presence state", async () => {
  store.createWork("sample", {
    slug: "room-state",
    title: "Room state",
    implementer: "expected-impl",
  });
  let room = store
    .listRooms()
    .find(({ work }) => work.slug === "room-state");
  assert.deepEqual(room.expected_participant, {
    identifier: "expected-impl",
    role: "implementer",
  });
  assert.deepEqual(room.presence, {
    registered: false,
    present: false,
    first_seen_at: null,
    last_heartbeat_at: null,
    ball: { has_ball: false, reasons: [] },
    abandoned: false,
  });

  post("room-state", {
    from: "expected-impl",
    role: "implementer",
    body: "active",
  });
  post("room-state", {
    type: "question",
    body: "Please continue",
    to: ["expected-impl"],
  });
  room = store.listRooms().find(({ work }) => work.slug === "room-state");
  assert.equal(room.presence.present, true);
  assert.equal(room.presence.ball.has_ball, true);
  assert.equal(room.presence.abandoned, false);
  assert.equal(room.presence.last_heartbeat_at, "2026-07-26T00:00:00.000Z");

  currentTime = new Date(currentTime.getTime() + 3 * 60_000 + 1);
  room = store.listRooms().find(({ work }) => work.slug === "room-state");
  assert.equal(room.presence.present, false);
  assert.equal(room.presence.ball.has_ball, true);
  assert.equal(room.presence.abandoned, true);

  await withServer(async (base) => {
    const response = await request(base, "GET", "/api/v1/rooms");
    assert.equal(response.status, 200);
    assert.equal(
      response.body.rooms.find(({ work }) => work.slug === "room-state")
        .presence.abandoned,
      true,
    );
  });
});

test("two clients updating the same base revision produce one 200 and one 409", async () => {
  store.createDocument("sample", {
    kind: "context",
    title: "Context",
    body: "revision one",
    author: "designer",
  });

  await withServer(async (base) => {
    const payload = (body) => ({
      body,
      base_revision: 1,
      author: "designer",
    });
    const responses = await Promise.all([
      request(
        base,
        "PUT",
        "/api/v1/projects/sample/documents/context",
        payload("client A"),
      ),
      request(
        base,
        "PUT",
        "/api/v1/projects/sample/documents/context",
        payload("client B"),
      ),
    ]);
    assert.deepEqual(
      responses.map(({ status }) => status).sort(),
      [200, 409],
    );
    const conflict = responses.find(({ status }) => status === 409).body;
    assert.equal(conflict.current_revision, 2);
    assert.match(conflict.current_body, /^client [AB]$/);
  });
});

test("concurrent message posts allocate a gapless unique sequence", async () => {
  await withServer(async (base) => {
    const count = 60;
    const responses = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        request(
          base,
          "POST",
          "/api/v1/projects/sample/works/work-one/messages",
          {
          idempotency_key: crypto.randomUUID(),
          from: `impl-${index}`,
          role: "implementer",
          type: "status",
          body: `message ${index}`,
          to: [],
          refs: [],
          },
        ),
      ),
    );
    assert.ok(responses.every(({ status }) => status === 201));
    const messages = store.listMessages("sample", "work-one");
    assert.deepEqual(
      messages.map(({ seq }) => seq),
      Array.from({ length: count }, (_, index) => index + 1),
    );
  });
});

test("idempotency returns the original message and creates one row", async () => {
  await withServer(async (base) => {
    const payload = {
      idempotency_key: "same-key",
      from: "implementer",
      role: "implementer",
      type: "status",
      body: "once",
      to: [],
      refs: [],
    };
    const responses = await Promise.all([
      request(
        base,
        "POST",
        "/api/v1/projects/sample/works/work-one/messages",
        payload,
      ),
      request(
        base,
        "POST",
        "/api/v1/projects/sample/works/work-one/messages",
        payload,
      ),
    ]);
    assert.deepEqual(responses.map(({ body }) => body.seq), [1, 1]);
    assert.equal(store.listMessages("sample", "work-one").length, 1);
  });
});

test("the same work slug is isolated by project", async () => {
  store.createProject({ slug: "other", name: "Other" });
  store.createWork("other", { slug: "work-one", title: "Other work one" });

  await withServer(async (base) => {
    const payload = (body) => ({
      idempotency_key: crypto.randomUUID(),
      from: "designer",
      role: "designer",
      type: "message",
      body,
      to: [],
      refs: [],
    });
    const sample = await request(
      base,
      "POST",
      "/api/v1/projects/sample/works/work-one/messages",
      payload("sample message"),
    );
    const other = await request(
      base,
      "POST",
      "/api/v1/projects/other/works/work-one/messages",
      payload("other message"),
    );

    assert.equal(sample.status, 201);
    assert.equal(other.status, 201);
    assert.equal(sample.body.seq, 1);
    assert.equal(other.body.seq, 1);
  });

  assert.deepEqual(
    store.listMessages("sample", "work-one").map(({ body }) => body),
    ["sample message"],
  );
  assert.deepEqual(
    store.listMessages("other", "work-one").map(({ body }) => body),
    ["other message"],
  );
});

test("question ball is independent per recipient and explicit close clears it", () => {
  const question = post("work-one", {
    type: "question",
    body: "Both recipients must answer",
    to: ["impl-a", "impl-b"],
  });
  post("work-one", {
    from: "impl-a",
    role: "implementer",
    type: "answer",
    reply_to: question.seq,
    body: "A answered",
    to: ["designer"],
  });

  assert.equal(store.ballFor(1, "impl-a").has_ball, false);
  assert.equal(store.ballFor(1, "impl-b").has_ball, true);
  assert.equal(
    store.ballFor(1, "impl-b").reasons[0].kind,
    "unanswered_question",
  );

  store.closeQuestion("sample", "work-one", question.seq, "designer");
  assert.equal(store.ballFor(1, "impl-a").has_ball, false);
  assert.equal(store.ballFor(1, "impl-b").has_ball, false);
});

test("a declared ball cannot clear a derived unanswered-question ball", () => {
  post("work-one", {
    type: "question",
    body: "Please answer",
    to: ["implementer"],
  });
  post("work-one", {
    type: "status",
    body: "Declaration deliberately clears only declared balls",
    ball: [],
  });
  const ball = store.ballFor(1, "implementer");
  assert.equal(ball.has_ball, true);
  assert.deepEqual(ball.reasons.map(({ kind }) => kind), [
    "unanswered_question",
  ]);
});

test("a participant with the ball and a stale heartbeat is abandoned", () => {
  post("work-one", {
    from: "implementer",
    role: "implementer",
    body: "I am present",
  });
  store.poll("sample", "work-one", "implementer", "implementer", 0);
  post("work-one", {
    type: "question",
    body: "Owner needs this answered",
    to: ["implementer"],
  });

  currentTime = new Date(currentTime.getTime() + 3 * 60_000 + 1);
  const result = store.poll("sample", "work-one", "designer", "designer", 0);
  assert.equal(result.abandoned.length, 1);
  assert.equal(result.abandoned[0].identifier, "implementer");
  assert.equal(
    result.abandoned[0].ball_reasons[0].kind,
    "unanswered_question",
  );
});

test("passive polls never refresh heartbeat and cannot hide abandonment", () => {
  post("work-one", {
    type: "question",
    body: "A background watcher must not hide this ball",
    to: ["watch-only"],
  });

  const first = store.poll(
    "sample",
    "work-one",
    "watch-only",
    "implementer",
    0,
    false,
  );
  assert.equal(first.heartbeat_at, null);
  const firstSeen = store
    .participantStates(1)
    .find(({ identifier }) => identifier === "watch-only").first_seen_at;

  currentTime = new Date(currentTime.getTime() + 2 * 60_000);
  const second = store.poll(
    "sample",
    "work-one",
    "watch-only",
    "implementer",
    0,
    false,
  );
  assert.equal(second.heartbeat_at, null);
  assert.equal(
    store
      .participantStates(1)
      .find(({ identifier }) => identifier === "watch-only").first_seen_at,
    firstSeen,
  );

  currentTime = new Date(currentTime.getTime() + 60_001);
  store.poll(
    "sample",
    "work-one",
    "watch-only",
    "implementer",
    0,
    false,
  );
  const observer = store.poll(
    "sample",
    "work-one",
    "designer",
    "designer",
    0,
  );
  assert.equal(observer.abandoned.length, 1);
  assert.equal(observer.abandoned[0].identifier, "watch-only");
  assert.equal(observer.abandoned[0].last_heartbeat_at, null);
});

test("active post and poll update attention heartbeat", () => {
  post("work-one", {
    from: "active-impl",
    role: "implementer",
    body: "active post",
  });
  assert.equal(
    store
      .participantStates(1)
      .find(({ identifier }) => identifier === "active-impl")
      .last_heartbeat_at,
    "2026-07-26T00:00:00.000Z",
  );

  currentTime = new Date(currentTime.getTime() + 1_000);
  const passive = store.poll(
    "sample",
    "work-one",
    "active-impl",
    "implementer",
    0,
    false,
  );
  assert.equal(passive.heartbeat_at, "2026-07-26T00:00:00.000Z");

  currentTime = new Date(currentTime.getTime() + 1_000);
  const active = store.poll(
    "sample",
    "work-one",
    "active-impl",
    "implementer",
    0,
  );
  assert.equal(active.heartbeat_at, "2026-07-26T00:00:02.000Z");
});

test("poll infers an existing role, requires one for registration, and reports conflicts", async () => {
  post("work-one", { body: "register designer" });

  await withServer(async (base) => {
    const missing = await request(
      base,
      "GET",
      "/api/v1/projects/sample/works/work-one/poll?as=brand-new",
    );
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "role_required");

    const existing = await request(
      base,
      "GET",
      "/api/v1/projects/sample/works/work-one/poll?as=designer",
    );
    assert.equal(existing.status, 200);
    assert.match(existing.body.heartbeat_at, /^2026-07-26T/);

    const conflict = await request(
      base,
      "GET",
      "/api/v1/projects/sample/works/work-one/poll?as=designer&role=implementer",
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.registered_role, "designer");
    assert.equal(conflict.body.requested_role, "implementer");
    assert.match(conflict.body.message, /designer.*implementer/);

    const registered = await request(
      base,
      "GET",
      "/api/v1/projects/sample/works/work-one/poll?as=brand-new&role=implementer",
    );
    assert.equal(registered.status, 200);
    assert.match(registered.body.heartbeat_at, /^2026-07-26T/);

    const invalidHeartbeat = await request(
      base,
      "GET",
      "/api/v1/projects/sample/works/work-one/poll?as=designer&heartbeat=maybe",
    );
    assert.equal(invalidHeartbeat.status, 400);
    assert.match(invalidHeartbeat.body.message, /heartbeat must be true or false/);
  });
});

test("resolve does not suppress abandonment or idle nudges", () => {
  post("work-one", {
    from: "implementer",
    role: "implementer",
    body: "heartbeat seed",
  });
  store.poll("sample", "work-one", "implementer", "implementer", 0);
  post("work-one", {
    type: "question",
    body: "Still pending after resolve",
    to: ["implementer"],
  });
  store.resolveWork("sample", "work-one");
  currentTime = new Date(currentTime.getTime() + 3 * 60_000 + 1);
  assert.equal(
    store.poll("sample", "work-one", "designer", "designer", 0).abandoned[0]
      .identifier,
    "implementer",
  );

  store.createWork("sample", { slug: "idle-work", title: "Idle" });
  post("idle-work", {
    from: "idle-impl",
    role: "implementer",
    body: "finished",
    ball: [],
  });
  store.resolveWork("sample", "idle-work");
  currentTime = new Date(currentTime.getTime() + 5 * 60_000 + 1);
  const idle = store.poll(
    "sample",
    "idle-work",
    "idle-impl",
    "implementer",
    0,
  );
  assert.match(idle.idle_nudge, /5 minutes/);

  post("idle-work", {
    from: "idle-impl",
    role: "implementer",
    body: "I checked the state",
    ball: [],
  });
  assert.equal(
    store.poll("sample", "idle-work", "idle-impl", "implementer", 0)
      .idle_nudge,
    null,
  );
});

test("stale expected revisions are advisory and appear on poll", () => {
  store.createDocument("sample", {
    kind: "context",
    title: "Context",
    body: "one",
    author: "designer",
  });
  post("work-one", {
    from: "implementer",
    role: "implementer",
    expects: [{ doc: "context", revision: 1 }],
  });
  store.updateDocument("sample", "context", {
    body: "two",
    base_revision: 1,
    author: "designer",
  });
  const result = store.poll(
    "sample",
    "work-one",
    "implementer",
    "implementer",
    0,
  );
  assert.deepEqual(result.stale_expectations, [
    { doc: "context", you_have: 1, current: 2 },
  ]);
});

test("import preserves every line, original duplicate IDs, and unresolved replies", () => {
  const result = store.importBundle({
    project: { slug: "legacy", name: "Legacy" },
    documents: [
      {
        adr_number: 7,
        author: "import",
        body: "# ADR 7",
        kind: "adr",
        slug: "0007-original-number",
        title: "Original number",
      },
    ],
    sessions: [
      {
        work_slug: "legacy-work",
        title: "Legacy work",
        messages: [
          {
            id: "msg-0001",
            ts: "2026-07-26T09:00:00+09:00",
            from: "designer",
            to: ["implementer"],
            type: "question",
            body: "question",
          },
          {
            id: "msg-0002",
            ts: "2026-07-26T09:00:01+09:00",
            from: "implementer",
            to: ["designer"],
            type: "answer",
            body: "unique reply",
            reply_to: "msg-0001",
          },
          {
            id: "msg-0002",
            ts: "2026-07-26T09:00:02+09:00",
            from: "custom-agent",
            to: [],
            type: "future-type",
            body: "duplicate source id",
          },
          {
            id: "msg-0004",
            ts: "2026-07-26T09:00:03+09:00",
            from: "designer",
            to: [],
            type: "message",
            body: "ambiguous reply",
            reply_to: "msg-0002",
          },
        ],
      },
    ],
    works: [],
  });

  assert.equal(result.messages, 4);
  assert.deepEqual(result.uncertain_roles, ["custom-agent"]);
  assert.equal(result.mapped_types[0].original, "future-type");
  assert.equal(result.unresolved_replies[0].reply_to, "msg-0002");
  const messages = store.listMessages("legacy", "legacy-work");
  assert.deepEqual(messages.map(({ seq }) => seq), [1, 2, 3, 4]);
  assert.equal(messages[1].reply_to, 1);
  assert.equal(messages[3].reply_to, null);
  assert.ok(messages[1].refs.includes("imported-id:msg-0002"));
  assert.ok(messages[2].refs.includes("imported-id:msg-0002"));
  assert.ok(messages[3].refs.includes("unresolved-reply-to:msg-0002"));
  assert.equal(messages[0].created_at, "2026-07-26T00:00:00.000Z");
  const adr = store.listDocuments("legacy")[0];
  assert.equal(adr.slug, "0007-original-number");
});

test("import preflight reports every invalid timestamp and writes nothing", async () => {
  const before = {
    projects: database.prepare("SELECT COUNT(*) AS count FROM project").get().count,
    works: database.prepare("SELECT COUNT(*) AS count FROM work").get().count,
    documents: database.prepare("SELECT COUNT(*) AS count FROM document").get()
      .count,
    messages: database.prepare("SELECT COUNT(*) AS count FROM message").get().count,
  };
  const bundle = {
    project: { slug: "invalid-import", name: "Invalid import" },
    documents: [],
    works: [],
    sessions: [
      {
        work_slug: "first-work",
        messages: [
          {
            id: "msg-0001",
            ts: "not-a-time-one",
            from: "designer",
            type: "message",
            body: "first",
          },
          {
            id: "msg-0002",
            ts: "2026-07-26T09:00:00+09:00",
            closed_at: "not-a-time-two",
            from: "designer",
            type: "message",
            body: "second",
          },
        ],
      },
      {
        work_slug: "second-work",
        messages: [
          {
            id: "msg-0003",
            ts: "not-a-time-three",
            from: "implementer",
            type: "status",
            body: "third",
          },
        ],
      },
    ],
  };

  assert.throws(
    () => store.importBundle(bundle),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "import_validation_failed");
      assert.match(error.message, /3 field/);
      assert.deepEqual(
        error.details.errors.map(({ work, line, id, field, value }) => ({
          work,
          line,
          id,
          field,
          value,
        })),
        [
          {
            work: "first-work",
            line: 1,
            id: "msg-0001",
            field: "ts",
            value: "not-a-time-one",
          },
          {
            work: "first-work",
            line: 2,
            id: "msg-0002",
            field: "closed_at",
            value: "not-a-time-two",
          },
          {
            work: "second-work",
            line: 1,
            id: "msg-0003",
            field: "ts",
            value: "not-a-time-three",
          },
        ],
      );
      return true;
    },
  );
  assert.deepEqual(
    {
      projects: database.prepare("SELECT COUNT(*) AS count FROM project").get()
        .count,
      works: database.prepare("SELECT COUNT(*) AS count FROM work").get().count,
      documents: database.prepare("SELECT COUNT(*) AS count FROM document").get()
        .count,
      messages: database.prepare("SELECT COUNT(*) AS count FROM message").get()
        .count,
    },
    before,
  );

  await withServer(async (base) => {
    const response = await request(base, "POST", "/api/v1/import", bundle);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "import_validation_failed");
    assert.equal(response.body.errors.length, 3);
    assert.deepEqual(
      response.body.errors.map(({ work, line, field }) => ({
        work,
        line,
        field,
      })),
      [
        { work: "first-work", line: 1, field: "ts" },
        { work: "first-work", line: 2, field: "closed_at" },
        { work: "second-work", line: 1, field: "ts" },
      ],
    );
  });
  assert.equal(
    database
      .prepare("SELECT 1 FROM project WHERE slug = 'invalid-import'")
      .get(),
    undefined,
  );
});
