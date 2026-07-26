import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createDatabase } from "../src/db.js";
import { createHttpServer } from "../src/server.js";
import { createStore } from "../src/store.js";
import { renderMarkdown } from "../src/web.js";

let directory;
let database;
let store;
let application;
let base;
let question;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "ao-web-test-"));
  database = createDatabase(join(directory, "web.sqlite"));
  store = createStore(database);
  store.createProject({ slug: "web-project", name: "Web project" });
  store.createWork("web-project", { slug: "web-work", title: "Web work" });
  store.createDocument("web-project", {
    kind: "context",
    title: "Shared terms",
    body: "# Shared terms\n\n**Source of truth** and `copy`.",
    author: "designer",
  });
  store.updateDocument("web-project", "context", {
    body: "# Shared terms\n\nRevision two.",
    base_revision: 1,
    author: "designer",
    note: "second",
  });
  question = store.postMessage("web-project", "web-work", {
    idempotency_key: crypto.randomUUID(),
    from: "designer",
    role: "designer",
    type: "question",
    body: "Owner, choose one.",
    to: ["owner"],
    refs: ["docs/handoff/work.md"],
  });
  application = createHttpServer({ database, store });
  await new Promise((resolveListen) =>
    application.server.listen(0, "127.0.0.1", resolveListen),
  );
  base = `http://127.0.0.1:${application.server.address().port}`;
});

after(async () => {
  await new Promise((resolveClose) => application.server.close(resolveClose));
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("markdown rendering escapes HTML and renders basic structure", () => {
  const rendered = renderMarkdown("# Title\n\n<script>alert(1)</script>\n\n- item");
  assert.match(rendered, /<h1>Title<\/h1>/);
  assert.match(rendered, /&lt;script&gt;/);
  assert.doesNotMatch(rendered, /<script>/);
  assert.match(rendered, /<li>item<\/li>/);
});

test("web shows projects and the cross-project owner inbox", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /Web project/);
  assert.match(html, /オーナー受信箱/);
  assert.match(html, /Owner, choose one/);
  assert.match(html, /オーナーとして回答/);
  assert.doesNotMatch(html, /Owner inbox|Answer as owner/);
});

test("web shows current documents, revision history, and arbitrary revisions", async () => {
  const current = await (
    await fetch(
      `${base}/projects/web-project/document?doc=${encodeURIComponent("context")}`,
    )
  ).text();
  assert.match(current, /Revision two/);
  assert.match(current, /リビジョン 2/);
  assert.match(current, /リビジョン 1/);
  assert.match(current, /JST/);
  assert.doesNotMatch(current, /Revision history/);

  const old = await (
    await fetch(
      `${base}/projects/web-project/document?doc=${encodeURIComponent("context")}&revision=1`,
    )
  ).text();
  assert.match(old, /Source of truth/);
});

test("owner answers inbox questions and originates decisions from web forms", async () => {
  const answer = await fetch(
    `${base}/projects/web-project/works/web-work/messages`,
    {
    method: "POST",
    body: new URLSearchParams({
      body: "Use option A.",
      reply_to: String(question.seq),
      to: "designer",
      type: "answer",
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    },
  );
  assert.equal(answer.status, 303);
  assert.equal(store.inbox("owner").length, 0);
  const answerMessage = store.listMessages("web-project", "web-work").at(-1);
  assert.equal(answerMessage.from, "owner");
  assert.equal(answerMessage.reply_to, question.seq);

  const decision = await fetch(
    `${base}/projects/web-project/works/web-work/messages`,
    {
    method: "POST",
    body: new URLSearchParams({
      body: "Ship after review.",
      to: "designer,implementer",
      type: "decision",
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    },
  );
  assert.equal(decision.status, 303);
  const decisionMessage = store.listMessages("web-project", "web-work").at(-1);
  assert.equal(decisionMessage.type, "decision");
  assert.deepEqual(decisionMessage.to, ["designer", "implementer"]);
});

test("work page exposes conversation, reply links, and participant state", async () => {
  const html = await (
    await fetch(`${base}/projects/web-project/works/web-work`)
  ).text();
  assert.match(html, /会話/);
  assert.match(html, /参加者/);
  assert.match(html, /designer/);
  assert.match(html, /owner/);
  assert.match(html, /question/);
  assert.match(html, /返信先:/);
  assert.match(html, /オーナーとして投稿/);
  assert.match(html, /進行中/);
  assert.match(html, /ボールなし/);
  assert.match(html, /心拍なし/);
  assert.match(html, /JST/);
  assert.doesNotMatch(
    html,
    /Conversation|Participants|Post as owner|no heartbeat/,
  );
});
