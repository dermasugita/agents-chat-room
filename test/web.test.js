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
  store.createWork("web-project", {
    slug: "web-work",
    title: "Web work",
    implementer: "ui-implementer",
  });
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
  store.postMessage("web-project", "web-work", {
    idempotency_key: crypto.randomUUID(),
    from: "on-demand-reviewer",
    role: "designer",
    type: "status",
    body: "schedule=unavailable:no-scheduler first-unit=review",
    to: [],
    refs: [],
  });
  store.postMessage("web-project", "web-work", {
    idempotency_key: crypto.randomUUID(),
    from: "owner",
    role: "owner",
    type: "question",
    body: "Please activate and review.",
    to: ["on-demand-reviewer"],
    refs: [],
  });
  database
    .prepare(
      `UPDATE participant SET last_heartbeat_at = ?
       WHERE identifier = ?`,
    )
    .run("2020-01-01T00:00:00.000Z", "on-demand-reviewer");
  store.postMessage("web-project", "web-work", {
    idempotency_key: crypto.randomUUID(),
    from: "declared-reviewer",
    role: "designer",
    type: "status",
    body: "schedule=unavailable:no-scheduler first-unit=declared-review",
    to: [],
    refs: [],
  });
  store.postMessage("web-project", "web-work", {
    idempotency_key: crypto.randomUUID(),
    from: "owner",
    role: "owner",
    type: "status",
    body: "Please activate the declared reviewer.",
    to: [],
    refs: [],
    ball: ["declared-reviewer"],
  });
  database
    .prepare(
      `UPDATE participant SET last_heartbeat_at = ?
       WHERE identifier = ?`,
    )
    .run("2020-01-01T00:00:00.000Z", "declared-reviewer");
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

  const message = renderMarkdown(
    "line one\nline two\n\n```\ncode one\ncode two\n```",
    { hardBreaks: true },
  );
  assert.match(message, /<p>line one<br>\nline two<\/p>/);
  const codeBlock = message.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)?.[1];
  assert.ok(codeBlock);
  assert.match(codeBlock, /code one/);
  assert.match(codeBlock, /code two/);
  assert.doesNotMatch(codeBlock, /<br>/);
  assert.doesNotMatch(
    renderMarkdown("document line one\ndocument line two"),
    /<br>/,
  );
});

test("web shows projects and the cross-project owner inbox", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /Web project/);
  assert.match(html, /オーナー受信箱/);
  assert.match(html, /Owner, choose one/);
  assert.match(html, /オーナーとして回答/);
  assert.match(html, /いま起こすべき参加者/);
  assert.match(html, /awaiting_activation/);
  assert.match(html, /on-demand-reviewer/);
  assert.match(html, /未回答の question #3（owner より）/);
  assert.match(html, /declared-reviewer/);
  assert.match(html, /宣言されたボール #5（owner より）/);
  assert.doesNotMatch(html, /&quot;kind&quot;/);
  assert.match(html, /起動待ち/);
  assert.match(html, /data-submit-shortcut/);
  assert.match(html, /<aside class="sidebar">/);
  assert.match(html, /aria-label="作業スレッド"/);
  assert.match(html, /class="sidebar-link sidebar-home is-active" href="\/" aria-current="page"/);
  assert.match(html, /href="\/projects\/web-project\/works\/web-work"/);
  assert.match(html, /class="sidebar-project-toggle" type="button"/);
  assert.match(html, /aria-expanded="true" aria-controls="sidebar-project-0-works"/);
  assert.match(
    html,
    /data-sidebar-project-toggle data-project="web-project"\s*data-project-name="Web project"/,
  );
  assert.match(html, /id="sidebar-project-0-works"/);
  assert.match(html, /localStorage\.getItem\(storageKey\)/);
  assert.match(html, /localStorage\.setItem\(storageKey, String\(nextCollapsed\)\)/);
  assert.match(html, /workTree\.hidden = collapsed/);
  assert.match(html, /collapsed \? "▸" : "▾"/);
  assert.match(html, /event\.key !== "Enter" && event\.key !== " "/);
  assert.match(html, /@media \(max-width:760px\)/);
  assert.doesNotMatch(html, /Owner inbox|Answer as owner/);
});

test("sidebar shows project-work hierarchy and the current location", async () => {
  const project = await (
    await fetch(`${base}/projects/web-project`)
  ).text();
  assert.match(
    project,
    /sidebar-project-link is-active"[\s\S]*?href="\/projects\/web-project" aria-current="page"/,
  );
  assert.match(
    project,
    /<button class="sidebar-project-toggle"[\s\S]*?<\/button>\s*<a class="sidebar-link sidebar-project-link is-active"/,
  );

  const document = await (
    await fetch(`${base}/projects/web-project/document?doc=context`)
  ).text();
  assert.match(
    document,
    /sidebar-project-link is-active"[\s\S]*?href="\/projects\/web-project" aria-current="location"/,
  );

  const work = await (
    await fetch(`${base}/projects/web-project/works/web-work`)
  ).text();
  assert.match(
    work,
    /sidebar-project-link is-active"[\s\S]*?href="\/projects\/web-project" aria-current="location"/,
  );
  assert.match(
    work,
    /sidebar-work is-active"[\s\S]*?href="\/projects\/web-project\/works\/web-work" aria-current="page"/,
  );
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
  assert.match(current, /class="card markdown document-body"/);
  assert.match(current, /<details class="card revision-history">/);
  assert.match(current, /<summary>リビジョン履歴/);
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

  const ownerQuestion = await fetch(
    `${base}/projects/web-project/works/web-work/messages`,
    {
      method: "POST",
      body: new URLSearchParams({
        body: "What should ship next?",
        to: "designer",
        type: "question",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    },
  );
  assert.equal(ownerQuestion.status, 303);
  const questionMessage = store.listMessages("web-project", "web-work").at(-1);
  assert.equal(questionMessage.type, "question");
  assert.deepEqual(questionMessage.to, ["designer"]);
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
  assert.match(html, /自走型/);
  assert.match(html, /起動待ち型/);
  assert.match(html, /起動待ち/);
  assert.doesNotMatch(
    html.match(/<tr><td>on-demand-reviewer<\/td>[\s\S]*?<\/tr>/)?.[0] ?? "",
    /離脱/,
  );
  assert.match(html, /対象外/);
  assert.match(html, /未接続/);
  assert.match(html, /ui-implementer/);
  assert.match(html, /担当枠/);
  assert.match(html, /参加待ち/);
  assert.doesNotMatch(html, /心拍なし/);
  assert.match(html, /<option value="question">question<\/option>/);
  assert.match(html, /question<\/code> の投稿には宛先が必要です/);
  assert.match(html, /data-owner-post-form/);
  assert.match(html, /data-submit-shortcut/);
  assert.match(html, /event\.metaKey/);
  assert.match(html, /event\.ctrlKey/);
  assert.match(html, /form\.requestSubmit\(\)/);
  assert.match(html, /JST/);

  store.poll("web-project", "web-work", "designer", "designer", 0);
  const connected = await (
    await fetch(`${base}/projects/web-project/works/web-work`)
  ).text();
  assert.match(connected, /JST（\d+秒前）/);

  store.poll("web-project", "web-work", "ui-implementer", "implementer", 0);
  const joined = await (
    await fetch(`${base}/projects/web-project/works/web-work`)
  ).text();
  assert.equal(joined.match(/<td>ui-implementer<\/td>/g)?.length, 1);
  assert.match(joined, /担当枠/);
  assert.doesNotMatch(joined, /参加待ち/);

  assert.doesNotMatch(
    html,
    /Conversation|Participants|Post as owner|no heartbeat/,
  );
});

test("web exposes cross-project and project issue views with owner lifecycle forms", async () => {
  const projectBefore = await (
    await fetch(`${base}/projects/web-project`)
  ).text();
  assert.match(
    projectBefore,
    /href="\/projects\/web-project\/issues"[^>]*>課題 <span class="meta">open 0<\/span>/,
  );

  const created = await fetch(`${base}/projects/web-project/issues`, {
    method: "POST",
    body: new URLSearchParams({
      title: "Web issue",
      body: "Owner-created **issue**.",
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get("location"), "/projects/web-project/issues/1");
  assert.deepEqual(
    (({
      project,
      number,
      origin_project,
      origin_identifier,
      origin_role,
      state,
    }) => ({
      project,
      number,
      origin_project,
      origin_identifier,
      origin_role,
      state,
    }))(store.getIssue("web-project", 1)),
    {
      project: "web-project",
      number: 1,
      origin_project: "web-project",
      origin_identifier: "owner",
      origin_role: "owner",
      state: "open",
    },
  );

  const crossProject = await (await fetch(`${base}/issues`)).text();
  assert.match(crossProject, /未対応の課題/);
  assert.match(crossProject, /Web issue/);
  assert.match(crossProject, /web-project\/owner/);
  assert.match(crossProject, /<span class="badge">open<\/span>/);
  assert.match(
    crossProject,
    /sidebar-cross-issues is-active" href="\/issues" aria-current="page"/,
  );

  const openList = await (
    await fetch(`${base}/projects/web-project/issues`)
  ).text();
  assert.match(openList, /Web projectの課題/);
  assert.match(openList, /未対応 \(open\)/);
  assert.match(openList, /クローズ済み \(closed\)/);
  assert.match(openList, /すべて \(all\)/);
  assert.match(openList, /オーナーとして起票/);
  assert.match(
    openList,
    /sidebar-issues is-active"[\s\S]*?aria-current="page">課題/,
  );

  const commented = await fetch(
    `${base}/projects/web-project/issues/1/comments`,
    {
      method: "POST",
      body: new URLSearchParams({ body: "Owner comment" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    },
  );
  assert.equal(commented.status, 303);

  const rejectedClose = await fetch(
    `${base}/projects/web-project/issues/1/close`,
    {
      method: "POST",
      body: new URLSearchParams(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    },
  );
  assert.equal(rejectedClose.status, 400);

  const closed = await fetch(
    `${base}/projects/web-project/issues/1/close`,
    {
      method: "POST",
      body: new URLSearchParams({ reason: "対応済み" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    },
  );
  assert.equal(closed.status, 303);

  const detail = await (
    await fetch(`${base}/projects/web-project/issues/1`)
  ).text();
  assert.match(detail, /Owner-created <strong>issue<\/strong>/);
  assert.match(detail, /コメント #1/);
  assert.match(detail, /Owner comment/);
  assert.match(detail, /<span class="badge">closed<\/span>/);
  assert.match(detail, /クローズ理由:<\/strong> 対応済み/);
  assert.match(detail, /web-project\/owner/);
  assert.match(detail, /再オープン/);

  const defaultAfterClose = await (
    await fetch(`${base}/projects/web-project/issues`)
  ).text();
  assert.doesNotMatch(defaultAfterClose, /#1 Web issue/);
  const closedList = await (
    await fetch(`${base}/projects/web-project/issues?state=closed`)
  ).text();
  assert.match(closedList, /#1 Web issue/);
  assert.match(closedList, /<span class="badge">closed<\/span>/);

  const reopened = await fetch(
    `${base}/projects/web-project/issues/1/reopen`,
    { method: "POST", redirect: "manual" },
  );
  assert.equal(reopened.status, 303);
  assert.equal(store.getIssue("web-project", 1).state, "open");
});
