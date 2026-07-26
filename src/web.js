import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";

const MAX_FORM_BYTES = 256 * 1024;
const JST_FORMATTER = new Intl.DateTimeFormat("ja-JP-u-ca-gregory-nu-latn", {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: "Asia/Tokyo",
  year: "numeric",
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function formatJst(value) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const parts = Object.fromEntries(
    JST_FORMATTER.formatToParts(date).map(({ type, value: part }) => [
      type,
      part,
    ]),
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second} JST`;
}

function formatElapsed(value) {
  const elapsedMs = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsedMs < 60_000) {
    return `${Math.floor(elapsedMs / 1_000)}秒前`;
  }
  if (elapsedMs < 60 * 60_000) {
    return `${Math.floor(elapsedMs / 60_000)}分前`;
  }
  if (elapsedMs < 24 * 60 * 60_000) {
    return `${Math.floor(elapsedMs / (60 * 60_000))}時間前`;
  }
  return `${Math.floor(elapsedMs / (24 * 60 * 60_000))}日前`;
}

function heartbeatLabel(participant) {
  if (participant.role === "owner") {
    return "対象外";
  }
  if (!participant.last_heartbeat_at) {
    return "未接続";
  }
  return `${formatJst(participant.last_heartbeat_at)}（${formatElapsed(participant.last_heartbeat_at)}）`;
}

function workStateLabel(state) {
  if (state === "open") {
    return "進行中";
  }
  if (state === "resolved") {
    return "resolve 済み";
  }
  return state;
}

export function renderMarkdown(markdown, { hardBreaks = false } = {}) {
  const output = [];
  let inCode = false;
  let listOpen = false;
  let paragraph = [];

  function flushParagraph() {
    if (paragraph.length > 0) {
      output.push(
        `<p>${paragraph
          .map((line) => inlineMarkdown(line))
          .join(hardBreaks ? "<br>\n" : " ")}</p>`,
      );
      paragraph = [];
    }
  }
  function closeList() {
    if (listOpen) {
      output.push("</ul>");
      listOpen = false;
    }
  }

  for (const line of String(markdown).split(/\r?\n/)) {
    if (line.startsWith("```")) {
      flushParagraph();
      closeList();
      output.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      output.push(`${escapeHtml(line)}\n`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (item) {
      flushParagraph();
      if (!listOpen) {
        output.push("<ul>");
        listOpen = true;
      }
      output.push(`<li>${inlineMarkdown(item[1])}</li>`);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeList();
  if (inCode) {
    output.push("</code></pre>");
  }
  return output.join("\n");
}

function sidebar(
  store,
  currentProject = undefined,
  currentWork = undefined,
  projectPageCurrent = false,
) {
  const projects = store.listProjects();
  const tree = projects
    .map((project) => {
      const projectDetails = store.getProject(project.slug);
      const projectActive = project.slug === currentProject;
      const projectCurrent = projectActive
        ? ` aria-current="${projectPageCurrent ? "page" : "location"}"`
        : "";
      const works =
        projectDetails.works
          .map((work) => {
            const workActive = projectActive && work.slug === currentWork;
            return `<li><a class="sidebar-link sidebar-work${workActive ? " is-active" : ""}"
              href="/projects/${encodeURIComponent(project.slug)}/works/${encodeURIComponent(work.slug)}"${workActive ? ' aria-current="page"' : ""}>${escapeHtml(work.title)}</a></li>`;
          })
          .join("") || '<li class="sidebar-empty">作業はまだありません。</li>';
      return `<li class="sidebar-project">
        <div class="sidebar-project-node"><span aria-hidden="true">▾</span>
          <a class="sidebar-link sidebar-project-link${projectActive ? " is-active" : ""}"
            href="/projects/${encodeURIComponent(project.slug)}"${projectCurrent}>${escapeHtml(project.name)}</a>
        </div>
        <ul class="sidebar-work-tree">${works}</ul>
      </li>`;
    })
    .join("");
  return `<aside class="sidebar">
    <nav aria-label="作業スレッド">
      <h2>作業スレッド</h2>
      <a class="sidebar-link sidebar-home${currentProject ? "" : " is-active"}" href="/"${currentProject ? "" : ' aria-current="page"'}>ホーム</a>
      <ul class="sidebar-project-tree">${tree || '<li class="sidebar-empty">プロジェクトはまだありません。</li>'}</ul>
    </nav>
  </aside>`;
}

function layout(title, body, navigation) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · agents-chat-room</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; background:#f6f7f9; color:#162033; }
    * { box-sizing:border-box; }
    body { margin:0; }
    header { background:#17243b; color:white; padding:1rem 1.5rem; }
    header a { color:white; text-decoration:none; }
    .app-shell { display:grid; grid-template-columns:200px minmax(0,1fr); gap:1rem; width:min(1500px,calc(100% - 2rem)); margin:1.5rem auto 0; align-items:start; }
    main { min-width:0; margin:0 0 4rem; }
    a { color:#2457a6; }
    .sidebar { position:sticky; top:1rem; max-height:calc(100vh - 2rem); overflow:auto; background:white; border:1px solid #dce1ea; border-radius:10px; padding:.8rem; box-shadow:0 1px 2px #1b2a4410; }
    .sidebar h2 { margin:.1rem .35rem .65rem; font-size:1rem; }
    .sidebar ul { list-style:none; margin:0; padding:0; }
    .sidebar-project-tree { display:grid; gap:.6rem; margin-top:.5rem !important; }
    .sidebar-project-node { display:flex; gap:.3rem; align-items:flex-start; color:#61708a; }
    .sidebar-work-tree { display:grid; gap:.15rem; margin:.2rem 0 0 1.25rem !important; border-left:1px solid #dce1ea; padding-left:.35rem !important; }
    .sidebar-link { display:block; border-radius:6px; padding:.3rem .4rem; color:#34445f; text-decoration:none; overflow-wrap:anywhere; }
    .sidebar-link:hover { background:#eef3fa; color:#183f7e; }
    .sidebar-link.is-active { background:#dce8fa; color:#173f7e; font-weight:700; }
    .sidebar-project-link { flex:1; }
    .sidebar-work { font-size:.88rem; }
    .sidebar-empty { color:#61708a; font-size:.82rem; padding:.3rem .4rem; }
    .grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); }
    .card { background:white; border:1px solid #dce1ea; border-radius:10px; padding:1rem; box-shadow:0 1px 2px #1b2a4410; }
    .meta { color:#61708a; font-size:.88rem; }
    .badge { display:inline-block; border-radius:999px; padding:.15rem .5rem; font-size:.78rem; background:#e6edf8; margin-right:.25rem; }
    .danger { background:#ffe2e2; color:#8b1d1d; }
    .ball { background:#fff0bd; color:#6f4b00; }
    .message { border-left:4px solid #9badc8; margin:.8rem 0; }
    .message.question { border-left-color:#d98b1c; }
    .message.answer { border-left-color:#25885c; }
    .markdown { line-height:1.55; overflow-wrap:anywhere; }
    .markdown pre { overflow:auto; padding:1rem; background:#101827; color:#edf2fa; border-radius:8px; }
    .document-body { width:100%; }
    .revision-history { margin-top:1rem; }
    .revision-history summary { cursor:pointer; font-size:1.2rem; font-weight:700; }
    .revision-history[open] summary { margin-bottom:.75rem; }
    code { background:#edf1f7; padding:.1rem .25rem; border-radius:4px; }
    pre code { background:transparent; padding:0; }
    form { display:grid; gap:.65rem; }
    input,textarea,select,button { font:inherit; }
    input,textarea,select { width:100%; padding:.55rem; border:1px solid #b9c3d2; border-radius:6px; background:white; }
    textarea { min-height:6rem; }
    button { width:max-content; border:0; border-radius:6px; padding:.55rem .85rem; background:#2457a6; color:white; cursor:pointer; }
    table { width:100%; border-collapse:collapse; }
    th,td { text-align:left; border-bottom:1px solid #dde3ec; padding:.55rem; vertical-align:top; }
    @media (max-width:760px) {
      .app-shell { display:block; width:calc(100% - 1rem); margin-top:.5rem; }
      .sidebar { position:static; max-height:none; margin-bottom:1rem; }
      main { margin-bottom:3rem; }
    }
  </style>
</head>
<body>
<header><a href="/"><strong>agents-chat-room</strong></a> <span class="meta">オーナー画面</span></header>
<div class="app-shell">
${navigation}
<main>${body}</main>
</div>
<script>
  document.addEventListener("keydown", (event) => {
    if (
      event.isComposing ||
      event.key !== "Enter" ||
      (!event.metaKey && !event.ctrlKey) ||
      !event.target?.matches?.("textarea[data-submit-shortcut]")
    ) {
      return;
    }
    const form = event.target.form;
    if (!form) {
      return;
    }
    event.preventDefault();
    form.requestSubmit();
  });

  document.querySelectorAll("form[data-owner-post-form]").forEach((form) => {
    const type = form.querySelector("[data-owner-message-type]");
    const recipients = form.querySelector("[data-owner-message-to]");
    const syncRecipients = () => {
      const required = type.value === "question";
      recipients.required = required;
      recipients.setCustomValidity(
        required && !recipients.value.trim()
          ? "question の宛先を入力してください。"
          : "",
      );
      return !recipients.validationMessage;
    };
    type.addEventListener("change", syncRecipients);
    recipients.addEventListener("input", syncRecipients);
    form.addEventListener("submit", (event) => {
      if (!syncRecipients()) {
        event.preventDefault();
        recipients.reportValidity();
      }
    });
    syncRecipients();
  });
</script>
</body>
</html>`;
}

function html(response, status, body) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function redirect(response, location) {
  response.writeHead(303, { location });
  response.end();
}

async function readForm(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_FORM_BYTES) {
      throw new AppError(413, "body_too_large", "Form body is too large");
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function projectCard(project) {
  return `<article class="card">
    <h2><a href="/projects/${encodeURIComponent(project.slug)}">${escapeHtml(project.name)}</a></h2>
    <p class="meta">${escapeHtml(project.slug)} · 文書 ${project.document_count}件 · 作業 ${project.work_count}件</p>
  </article>`;
}

function inboxCard(question) {
  const message = question.message;
  return `<article class="card message question">
    <div><span class="badge">question #${message.seq}</span> <strong>${escapeHtml(message.from)}</strong></div>
    <p class="meta"><a href="/projects/${encodeURIComponent(question.project)}">${escapeHtml(question.project)}</a>
      / <a href="/projects/${encodeURIComponent(question.project)}/works/${encodeURIComponent(question.work)}">${escapeHtml(question.work)}</a></p>
    <div class="markdown">${renderMarkdown(message.body, { hardBreaks: true })}</div>
    <form method="post" action="/projects/${encodeURIComponent(question.project)}/works/${encodeURIComponent(question.work)}/messages">
      <input type="hidden" name="type" value="answer">
      <input type="hidden" name="reply_to" value="${message.seq}">
      <input type="hidden" name="to" value="${escapeHtml(message.from)}">
      <label>回答<textarea name="body" required data-submit-shortcut></textarea></label>
      <button type="submit">オーナーとして回答</button>
    </form>
  </article>`;
}

function home(store) {
  const projects = store.listProjects();
  const questions = store.inbox("owner");
  return layout(
    "プロジェクト",
    `<h1>プロジェクト</h1>
     <div class="grid">${projects.map(projectCard).join("") || '<p class="card">プロジェクトはまだありません。</p>'}</div>
     <h1>オーナー受信箱</h1>
     <p class="meta">全プロジェクトの <code>owner</code> 宛未回答 <code>question</code>。</p>
     <div class="grid">${questions.map(inboxCard).join("") || '<p class="card">未回答の question はありません。</p>'}</div>`,
    sidebar(store),
  );
}

function projectPage(store, slug) {
  const project = store.getProject(slug);
  const documents = project.documents
    .map(
      (document) => `<tr>
        <td><a href="/projects/${encodeURIComponent(slug)}/document?doc=${encodeURIComponent(document.doc)}">${escapeHtml(document.title)}</a></td>
        <td>${escapeHtml(document.kind)}</td><td>${document.current_revision}</td>
      </tr>`,
    )
    .join("") || '<tr><td colspan="3">文書はまだありません。</td></tr>';
  const works = project.works
    .map(
      (work) => `<tr>
        <td><a href="/projects/${encodeURIComponent(slug)}/works/${encodeURIComponent(work.slug)}">${escapeHtml(work.title)}</a></td>
        <td>${escapeHtml(work.slug)}</td><td><span class="badge">${escapeHtml(workStateLabel(work.state))}</span></td>
      </tr>`,
    )
    .join("") || '<tr><td colspan="3">作業はまだありません。</td></tr>';
  return layout(
    project.name,
    `<p><a href="/">← プロジェクト一覧</a></p>
     <h1>${escapeHtml(project.name)}</h1><p class="meta">${escapeHtml(project.slug)}</p>
     <section class="card"><h2>文書</h2><table><thead><tr><th>タイトル</th><th>文書種別</th><th>リビジョン</th></tr></thead><tbody>${documents}</tbody></table></section>
     <section class="card"><h2>作業</h2><table><thead><tr><th>タイトル</th><th>作業識別子</th><th>状態</th></tr></thead><tbody>${works}</tbody></table></section>`,
    sidebar(store, slug, undefined, true),
  );
}

function documentPage(store, projectSlug, identifier, revision) {
  const document = store.getDocument(projectSlug, identifier, revision);
  const revisions = store.listRevisions(projectSlug, identifier);
  return layout(
    document.title,
    `<p><a href="/projects/${encodeURIComponent(projectSlug)}">← プロジェクト</a></p>
     <h1>${escapeHtml(document.title)}</h1>
     <p class="meta">${escapeHtml(document.doc)} · リビジョン ${document.revision} · ${escapeHtml(document.author)} · ${escapeHtml(formatJst(document.updated_at))}</p>
     <article class="card markdown document-body">${renderMarkdown(document.body)}</article>
     <details class="card revision-history">
       <summary>リビジョン履歴 <span class="meta">${revisions.length}件</span></summary>
       <ol>${revisions
         .map(
           (item) =>
             `<li><a href="/projects/${encodeURIComponent(projectSlug)}/document?doc=${encodeURIComponent(identifier)}&revision=${item.revision}">リビジョン ${item.revision}</a>
              <span class="meta">${escapeHtml(item.author)} · ${escapeHtml(formatJst(item.created_at))}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</span></li>`,
         )
         .join("")}</ol>
     </details>`,
    sidebar(store, projectSlug),
  );
}

function participantRow(participant) {
  const badges = [
    participant.ball.has_ball ? '<span class="badge ball">ボールあり</span>' : "",
    participant.abandoned ? '<span class="badge danger">離脱</span>' : "",
  ].join("");
  return `<tr><td>${escapeHtml(participant.identifier)}</td><td>${escapeHtml(participant.role)}</td>
    <td>${badges || '<span class="badge">ボールなし</span>'}</td>
    <td class="meta">${escapeHtml(heartbeatLabel(participant))}</td></tr>`;
}

function messageCard(message, projectSlug, workSlug) {
  const answerForm =
    message.type === "question" && !message.closed_at && message.to.includes("owner")
      ? `<form method="post" action="/projects/${encodeURIComponent(projectSlug)}/works/${encodeURIComponent(workSlug)}/messages">
          <input type="hidden" name="type" value="answer">
          <input type="hidden" name="reply_to" value="${message.seq}">
          <input type="hidden" name="to" value="${escapeHtml(message.from)}">
          <label>回答<textarea name="body" required data-submit-shortcut></textarea></label>
          <button type="submit">オーナーとして回答</button>
        </form>`
      : "";
  return `<article class="card message ${escapeHtml(message.type)}">
    <div><span class="badge">${escapeHtml(message.type)} #${message.seq}</span>
      <strong>${escapeHtml(message.from)}</strong>
      ${message.closed_at ? '<span class="badge">クローズ済み</span>' : ""}</div>
    <p class="meta">宛先: ${escapeHtml(message.to.join(", ") || "—")} · 返信先: ${escapeHtml(message.reply_to ?? "—")} · ${escapeHtml(formatJst(message.created_at))}</p>
    <div class="markdown">${renderMarkdown(message.body, { hardBreaks: true })}</div>
    ${message.refs.length ? `<p class="meta">参照: ${message.refs.map(escapeHtml).join(", ")}</p>` : ""}
    ${answerForm}
  </article>`;
}

function workPage(store, projectSlug, slug) {
  const work = store.getWork(projectSlug, slug);
  return layout(
    work.title,
    `<p><a href="/projects/${encodeURIComponent(work.project)}">← プロジェクト</a></p>
     <h1>${escapeHtml(work.title)}</h1>
     <p class="meta">${escapeHtml(work.slug)} · <span class="badge">${escapeHtml(workStateLabel(work.state))}</span></p>
     <section class="card"><h2>参加者</h2><table><thead><tr><th>識別子</th><th>ロール</th><th>状態</th><th>最終心拍</th></tr></thead>
       <tbody>${work.participants.map(participantRow).join("") || '<tr><td colspan="4">参加者はまだいません。</td></tr>'}</tbody></table></section>
     <section><h2>会話</h2>${work.messages.map((message) => messageCard(message, projectSlug, slug)).join("") || '<p class="card">メッセージはまだありません。</p>'}</section>
     <section class="card"><h2>オーナーとして投稿</h2>
       <form method="post" action="/projects/${encodeURIComponent(projectSlug)}/works/${encodeURIComponent(slug)}/messages" data-owner-post-form>
         <label>種別<select name="type" data-owner-message-type><option value="message">message</option><option value="decision">decision</option><option value="question">question</option></select></label>
         <label>宛先（カンマ区切り）<input name="to" data-owner-message-to aria-describedby="owner-question-recipient-help"></label>
         <p class="meta" id="owner-question-recipient-help"><code>question</code> の投稿には宛先が必要です。</p>
         <label>本文<textarea name="body" required data-submit-shortcut></textarea></label>
         <button type="submit">投稿</button>
       </form>
     </section>`,
    sidebar(store, projectSlug, slug),
  );
}

export async function routeWeb(request, response, url, store) {
  if (request.method === "GET" && url.pathname === "/") {
    html(response, 200, home(store));
    return true;
  }

  let match = url.pathname.match(/^\/projects\/([^/]+)$/);
  if (request.method === "GET" && match) {
    html(response, 200, projectPage(store, decodeURIComponent(match[1])));
    return true;
  }

  match = url.pathname.match(/^\/projects\/([^/]+)\/document$/);
  if (request.method === "GET" && match) {
    const identifier = url.searchParams.get("doc");
    if (!identifier) {
      throw new AppError(400, "invalid_request", "doc is required");
    }
    const revisionValue = url.searchParams.get("revision");
    const revision = revisionValue === null ? undefined : Number(revisionValue);
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
      throw new AppError(400, "invalid_request", "revision is invalid");
    }
    html(
      response,
      200,
      documentPage(store, decodeURIComponent(match[1]), identifier, revision),
    );
    return true;
  }

  match = url.pathname.match(/^\/projects\/([^/]+)\/works\/([^/]+)$/);
  if (request.method === "GET" && match) {
    html(
      response,
      200,
      workPage(
        store,
        decodeURIComponent(match[1]),
        decodeURIComponent(match[2]),
      ),
    );
    return true;
  }

  match = url.pathname.match(
    /^\/projects\/([^/]+)\/works\/([^/]+)\/messages$/,
  );
  if (request.method === "POST" && match) {
    const projectSlug = decodeURIComponent(match[1]);
    const workSlug = decodeURIComponent(match[2]);
    const form = await readForm(request);
    const type = form.get("type") ?? "message";
    if (!["message", "question", "decision", "answer"].includes(type)) {
      throw new AppError(400, "invalid_request", "Unsupported owner message type");
    }
    const to = (form.get("to") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const replyTo = form.get("reply_to");
    store.postMessage(projectSlug, workSlug, {
      idempotency_key: randomUUID(),
      from: "owner",
      role: "owner",
      type,
      body: form.get("body") ?? "",
      to,
      refs: [],
      ...(replyTo ? { reply_to: Number(replyTo) } : {}),
    });
    redirect(
      response,
      `/projects/${encodeURIComponent(projectSlug)}/works/${encodeURIComponent(workSlug)}`,
    );
    return true;
  }

  return false;
}
