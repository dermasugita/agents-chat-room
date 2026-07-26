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
  issueCurrent = undefined,
  crossIssuesCurrent = false,
) {
  const projects = store.listProjects();
  const tree = projects
    .map((project, projectIndex) => {
      const projectDetails = store.getProject(project.slug);
      const projectActive = project.slug === currentProject;
      const workTreeId = `sidebar-project-${projectIndex}-works`;
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
      const issueLinkCurrent =
        projectActive && issueCurrent
          ? ` aria-current="${issueCurrent}"`
          : "";
      return `<li class="sidebar-project">
        <div class="sidebar-project-node">
          <button class="sidebar-project-toggle" type="button"
            aria-expanded="true" aria-controls="${workTreeId}"
            aria-label="${escapeHtml(project.name)}の作業を折りたたむ"
            data-sidebar-project-toggle data-project="${escapeHtml(project.slug)}"
            data-project-name="${escapeHtml(project.name)}"><span aria-hidden="true" data-sidebar-project-symbol>▾</span></button>
          <a class="sidebar-link sidebar-project-link${projectActive ? " is-active" : ""}"
            href="/projects/${encodeURIComponent(project.slug)}"${projectCurrent}>${escapeHtml(project.name)}</a>
        </div>
        <a class="sidebar-link sidebar-issues${projectActive && issueCurrent ? " is-active" : ""}"
          href="/projects/${encodeURIComponent(project.slug)}/issues"${issueLinkCurrent}>課題 <span class="meta">open ${project.open_issue_count}</span></a>
        <ul class="sidebar-work-tree" id="${workTreeId}">${works}</ul>
      </li>`;
    })
    .join("");
  return `<aside class="sidebar">
    <nav aria-label="作業スレッド">
      <h2>作業スレッド</h2>
      <a class="sidebar-link sidebar-home${currentProject || crossIssuesCurrent ? "" : " is-active"}" href="/"${currentProject || crossIssuesCurrent ? "" : ' aria-current="page"'}>ホーム</a>
      <a class="sidebar-link sidebar-cross-issues${crossIssuesCurrent ? " is-active" : ""}" href="/issues"${crossIssuesCurrent ? ' aria-current="page"' : ""}>未対応の課題</a>
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
    .sidebar-project-node { display:flex; gap:.15rem; align-items:flex-start; color:#61708a; }
    .sidebar-project-toggle { flex:0 0 auto; display:grid; place-items:center; width:1.5rem; height:1.7rem; padding:0; background:transparent; color:#61708a; }
    .sidebar-project-toggle:hover { background:#eef3fa; color:#183f7e; }
    .sidebar-project-toggle:focus-visible { outline:2px solid #2457a6; outline-offset:1px; }
    .sidebar-work-tree { display:grid; gap:.15rem; margin:.2rem 0 0 1.25rem !important; border-left:1px solid #dce1ea; padding-left:.35rem !important; }
    .sidebar-work-tree[hidden] { display:none; }
    .sidebar-link { display:block; border-radius:6px; padding:.3rem .4rem; color:#34445f; text-decoration:none; overflow-wrap:anywhere; }
    .sidebar-link:hover { background:#eef3fa; color:#183f7e; }
    .sidebar-link.is-active { background:#dce8fa; color:#173f7e; font-weight:700; }
    .sidebar-project-link { flex:1; }
    .sidebar-issues { margin:.12rem 0 .12rem 1.65rem; font-size:.88rem; }
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
  document.querySelectorAll("[data-sidebar-project-toggle]").forEach((toggle) => {
    const workTree = document.getElementById(toggle.getAttribute("aria-controls"));
    const symbol = toggle.querySelector("[data-sidebar-project-symbol]");
    const project = toggle.dataset.project;
    const projectName = toggle.dataset.projectName;
    const storageKey = \`agents-chat-room.sidebar.project.\${project}.collapsed\`;
    const setCollapsed = (collapsed) => {
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute(
        "aria-label",
        \`\${projectName}の作業を\${collapsed ? "展開" : "折りたたむ"}\`,
      );
      workTree.hidden = collapsed;
      symbol.textContent = collapsed ? "▸" : "▾";
    };
    let collapsed = false;
    try {
      collapsed = localStorage.getItem(storageKey) === "true";
    } catch {
      // Storage can be unavailable without preventing navigation.
    }
    setCollapsed(collapsed);
    toggle.addEventListener("click", () => {
      const nextCollapsed = toggle.getAttribute("aria-expanded") === "true";
      setCollapsed(nextCollapsed);
      try {
        localStorage.setItem(storageKey, String(nextCollapsed));
      } catch {
        // The current page can still collapse even when persistence is unavailable.
      }
    });
    toggle.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      toggle.click();
    });
  });

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
    <p class="meta">${escapeHtml(project.slug)} · 文書 ${project.document_count}件 · 作業 ${project.work_count}件 · 課題 open ${project.open_issue_count}件</p>
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

function issuePath(project, number) {
  return `/projects/${encodeURIComponent(project)}/issues/${number}`;
}

function issueOrigin(issue) {
  const work = issue.origin_work
    ? ` · 作業 ${escapeHtml(issue.origin_work)}`
    : "";
  return `${escapeHtml(issue.origin_project)}/${escapeHtml(issue.origin_identifier)} (${escapeHtml(issue.origin_role)})${work}`;
}

function issueRows(issues, { showProject = false } = {}) {
  const columnCount = showProject ? 5 : 4;
  return (
    issues
      .map(
        (issue) => `<tr>
          ${showProject ? `<td><a href="/projects/${encodeURIComponent(issue.project)}/issues">${escapeHtml(issue.project_name)}</a></td>` : ""}
          <td><a href="${issuePath(issue.project, issue.number)}">#${issue.number} ${escapeHtml(issue.title)}</a></td>
          <td><span class="badge">${escapeHtml(issue.state)}</span></td>
          <td>${issueOrigin(issue)}</td>
          <td class="meta">${escapeHtml(formatJst(issue.created_at))}</td>
        </tr>`,
      )
      .join("") ||
    `<tr><td colspan="${columnCount}">該当する課題はありません。</td></tr>`
  );
}

function crossProjectIssuesPage(store) {
  const groups = store.listIssuesAcrossProjects("open");
  const issues = groups.flatMap(({ issues: projectIssues }) => projectIssues);
  return layout(
    "未対応の課題",
    `<h1>未対応の課題</h1>
     <p class="meta">全プロジェクトの <code>open</code> 課題。課題は通知やボールを作らないため、ここで確認します。</p>
     <section class="card"><table>
       <thead><tr><th>プロジェクト</th><th>課題</th><th>状態</th><th>出身</th><th>作成日時</th></tr></thead>
       <tbody>${issueRows(issues, { showProject: true })}</tbody>
     </table></section>`,
    sidebar(store, undefined, undefined, false, undefined, true),
  );
}

function issueStateNavigation(projectSlug, selectedState) {
  return `<nav aria-label="課題の状態">
    ${[
      ["open", "未対応"],
      ["closed", "クローズ済み"],
      ["all", "すべて"],
    ]
      .map(
        ([state, label]) =>
          `<a class="badge${selectedState === state ? " is-active" : ""}" href="/projects/${encodeURIComponent(projectSlug)}/issues?state=${state}"${selectedState === state ? ' aria-current="page"' : ""}>${label} (${state})</a>`,
      )
      .join(" ")}
  </nav>`;
}

function projectIssuesPage(store, projectSlug, state) {
  const project = store.getProject(projectSlug);
  const issues = store.listIssues(projectSlug, state);
  return layout(
    `${project.name}の課題`,
    `<p><a href="/projects/${encodeURIComponent(projectSlug)}">← プロジェクト</a></p>
     <h1>${escapeHtml(project.name)}の課題</h1>
     ${issueStateNavigation(projectSlug, state)}
     <section class="card"><table>
       <thead><tr><th>課題</th><th>状態</th><th>出身</th><th>作成日時</th></tr></thead>
       <tbody>${issueRows(issues)}</tbody>
     </table></section>
     <section class="card"><h2>オーナーとして起票</h2>
       <form method="post" action="/projects/${encodeURIComponent(projectSlug)}/issues">
         <label>題名<input name="title" required></label>
         <label>本文<textarea name="body" required data-submit-shortcut></textarea></label>
         <button type="submit">起票</button>
       </form>
     </section>`,
    sidebar(store, projectSlug, undefined, false, "page"),
  );
}

function issueCommentCard(comment) {
  return `<article class="card">
    <div><span class="badge">コメント #${comment.seq}</span>
      <strong>${escapeHtml(comment.origin_project)}/${escapeHtml(comment.origin_identifier)}</strong>
      <span class="meta">(${escapeHtml(comment.origin_role)}) · ${escapeHtml(formatJst(comment.created_at))}</span></div>
    <div class="markdown">${renderMarkdown(comment.body, { hardBreaks: true })}</div>
  </article>`;
}

function issueDetailPage(store, projectSlug, number) {
  const issue = store.getIssue(projectSlug, number);
  const stateAction =
    issue.state === "open"
      ? `<form method="post" action="${issuePath(projectSlug, number)}/close">
           <label>クローズ理由<input name="reason" required></label>
           <button type="submit">クローズ</button>
         </form>`
      : `<form method="post" action="${issuePath(projectSlug, number)}/reopen">
           <button type="submit">再オープン</button>
         </form>`;
  const closeDetails =
    issue.state === "closed"
      ? `<p><strong>クローズ理由:</strong> ${escapeHtml(issue.close_reason)}<br>
           <span class="meta">${escapeHtml(issue.closed_by)} · ${escapeHtml(formatJst(issue.closed_at))}</span></p>`
      : "";
  return layout(
    `#${issue.number} ${issue.title}`,
    `<p><a href="/projects/${encodeURIComponent(projectSlug)}/issues">← 課題一覧</a></p>
     <article class="card">
       <h1>#${issue.number} ${escapeHtml(issue.title)}</h1>
       <p><span class="badge">${escapeHtml(issue.state)}</span></p>
       <p class="meta">出身: ${issueOrigin(issue)} · ${escapeHtml(formatJst(issue.created_at))}</p>
       <div class="markdown">${renderMarkdown(issue.body, { hardBreaks: true })}</div>
       ${closeDetails}
       ${stateAction}
     </article>
     <section><h2>コメント</h2>
       ${issue.comments.map(issueCommentCard).join("") || '<p class="card">コメントはまだありません。</p>'}
     </section>
     <section class="card"><h2>オーナーとしてコメント</h2>
       <form method="post" action="${issuePath(projectSlug, number)}/comments">
         <label>本文<textarea name="body" required data-submit-shortcut></textarea></label>
         <button type="submit">コメント</button>
       </form>
     </section>`,
    sidebar(store, projectSlug, undefined, false, "location"),
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
    participant.expected ? '<span class="badge">担当枠</span>' : "",
    participant.waiting ? '<span class="badge">参加待ち</span>' : "",
    participant.ball.has_ball ? '<span class="badge ball">ボールあり</span>' : "",
    !participant.ball.has_ball ? '<span class="badge">ボールなし</span>' : "",
    participant.abandoned ? '<span class="badge danger">離脱</span>' : "",
  ].join("");
  return `<tr><td>${escapeHtml(participant.identifier)}</td><td>${escapeHtml(participant.role)}</td>
    <td>${badges}</td>
    <td class="meta">${escapeHtml(heartbeatLabel(participant))}</td></tr>`;
}

function participantsForDisplay(work) {
  if (!work.expected_participant) {
    return work.participants;
  }
  const expected = work.expected_participant;
  const registered = work.participants.find(
    ({ identifier }) => identifier === expected.identifier,
  );
  const expectedRow = registered
    ? { ...registered, expected: true }
    : {
        ...expected,
        expected: true,
        waiting: true,
        last_heartbeat_at: null,
        ball: { has_ball: false, reasons: [] },
        abandoned: false,
      };
  return [
    expectedRow,
    ...work.participants.filter(
      ({ identifier }) => identifier !== expected.identifier,
    ),
  ];
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
  const participants = participantsForDisplay(work);
  return layout(
    work.title,
    `<p><a href="/projects/${encodeURIComponent(work.project)}">← プロジェクト</a></p>
     <h1>${escapeHtml(work.title)}</h1>
     <p class="meta">${escapeHtml(work.slug)} · <span class="badge">${escapeHtml(workStateLabel(work.state))}</span></p>
     <section class="card"><h2>参加者</h2><table><thead><tr><th>識別子</th><th>ロール</th><th>状態</th><th>最終心拍</th></tr></thead>
       <tbody>${participants.map(participantRow).join("") || '<tr><td colspan="4">参加者はまだいません。</td></tr>'}</tbody></table></section>
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

  if (request.method === "GET" && url.pathname === "/issues") {
    html(response, 200, crossProjectIssuesPage(store));
    return true;
  }

  let match = url.pathname.match(/^\/projects\/([^/]+)$/);
  if (request.method === "GET" && match) {
    html(response, 200, projectPage(store, decodeURIComponent(match[1])));
    return true;
  }

  match = url.pathname.match(/^\/projects\/([^/]+)\/issues$/);
  if (match) {
    const projectSlug = decodeURIComponent(match[1]);
    if (request.method === "GET") {
      html(
        response,
        200,
        projectIssuesPage(
          store,
          projectSlug,
          url.searchParams.get("state") ?? "open",
        ),
      );
      return true;
    }
    if (request.method === "POST") {
      const form = await readForm(request);
      const issue = store.createIssue(projectSlug, {
        title: form.get("title") ?? "",
        body: form.get("body") ?? "",
        origin_project: projectSlug,
        origin_identifier: "owner",
        origin_role: "owner",
      });
      redirect(response, issuePath(projectSlug, issue.number));
      return true;
    }
  }

  match = url.pathname.match(/^\/projects\/([^/]+)\/issues\/(\d+)$/);
  if (request.method === "GET" && match) {
    html(
      response,
      200,
      issueDetailPage(
        store,
        decodeURIComponent(match[1]),
        Number(match[2]),
      ),
    );
    return true;
  }

  match = url.pathname.match(
    /^\/projects\/([^/]+)\/issues\/(\d+)\/comments$/,
  );
  if (request.method === "POST" && match) {
    const projectSlug = decodeURIComponent(match[1]);
    const number = Number(match[2]);
    const form = await readForm(request);
    store.addIssueComment(projectSlug, number, {
      body: form.get("body") ?? "",
      origin_project: projectSlug,
      origin_identifier: "owner",
      origin_role: "owner",
    });
    redirect(response, issuePath(projectSlug, number));
    return true;
  }

  match = url.pathname.match(
    /^\/projects\/([^/]+)\/issues\/(\d+)\/close$/,
  );
  if (request.method === "POST" && match) {
    const projectSlug = decodeURIComponent(match[1]);
    const number = Number(match[2]);
    const form = await readForm(request);
    store.closeIssue(projectSlug, number, {
      reason: form.get("reason") ?? "",
      origin_project: projectSlug,
      origin_identifier: "owner",
      origin_role: "owner",
    });
    redirect(response, issuePath(projectSlug, number));
    return true;
  }

  match = url.pathname.match(
    /^\/projects\/([^/]+)\/issues\/(\d+)\/reopen$/,
  );
  if (request.method === "POST" && match) {
    const projectSlug = decodeURIComponent(match[1]);
    const number = Number(match[2]);
    store.reopenIssue(projectSlug, number);
    redirect(response, issuePath(projectSlug, number));
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
