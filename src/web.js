import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";

const MAX_FORM_BYTES = 256 * 1024;

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

export function renderMarkdown(markdown) {
  const output = [];
  let inCode = false;
  let listOpen = false;
  let paragraph = [];

  function flushParagraph() {
    if (paragraph.length > 0) {
      output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
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

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
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
    main { width:min(1100px, calc(100% - 2rem)); margin:1.5rem auto 4rem; }
    a { color:#2457a6; }
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
    code { background:#edf1f7; padding:.1rem .25rem; border-radius:4px; }
    pre code { background:transparent; padding:0; }
    form { display:grid; gap:.65rem; }
    input,textarea,select,button { font:inherit; }
    input,textarea,select { width:100%; padding:.55rem; border:1px solid #b9c3d2; border-radius:6px; background:white; }
    textarea { min-height:6rem; }
    button { width:max-content; border:0; border-radius:6px; padding:.55rem .85rem; background:#2457a6; color:white; cursor:pointer; }
    table { width:100%; border-collapse:collapse; }
    th,td { text-align:left; border-bottom:1px solid #dde3ec; padding:.55rem; vertical-align:top; }
  </style>
</head>
<body>
<header><a href="/"><strong>agents-chat-room</strong></a> <span class="meta">owner endpoint</span></header>
<main>${body}</main>
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
    <p class="meta">${escapeHtml(project.slug)} · ${project.document_count} documents · ${project.work_count} works</p>
  </article>`;
}

function inboxCard(question) {
  const message = question.message;
  return `<article class="card message question">
    <div><span class="badge">question #${message.seq}</span> <strong>${escapeHtml(message.from)}</strong></div>
    <p class="meta"><a href="/projects/${encodeURIComponent(question.project)}">${escapeHtml(question.project)}</a>
      / <a href="/projects/${encodeURIComponent(question.project)}/works/${encodeURIComponent(question.work)}">${escapeHtml(question.work)}</a></p>
    <div class="markdown">${renderMarkdown(message.body)}</div>
    <form method="post" action="/projects/${encodeURIComponent(question.project)}/works/${encodeURIComponent(question.work)}/messages">
      <input type="hidden" name="type" value="answer">
      <input type="hidden" name="reply_to" value="${message.seq}">
      <input type="hidden" name="to" value="${escapeHtml(message.from)}">
      <label>Answer<textarea name="body" required></textarea></label>
      <button type="submit">Answer as owner</button>
    </form>
  </article>`;
}

function home(store) {
  const projects = store.listProjects();
  const questions = store.inbox("owner");
  return layout(
    "Projects",
    `<h1>Projects</h1>
     <div class="grid">${projects.map(projectCard).join("") || '<p class="card">No projects yet.</p>'}</div>
     <h1>Owner inbox</h1>
     <p class="meta">Unanswered questions addressed to <code>owner</code> across every project.</p>
     <div class="grid">${questions.map(inboxCard).join("") || '<p class="card">No unanswered questions.</p>'}</div>`,
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
    .join("");
  const works = project.works
    .map(
      (work) => `<tr>
        <td><a href="/projects/${encodeURIComponent(slug)}/works/${encodeURIComponent(work.slug)}">${escapeHtml(work.title)}</a></td>
        <td>${escapeHtml(work.slug)}</td><td><span class="badge">${escapeHtml(work.state)}</span></td>
      </tr>`,
    )
    .join("");
  return layout(
    project.name,
    `<p><a href="/">← Projects</a></p>
     <h1>${escapeHtml(project.name)}</h1><p class="meta">${escapeHtml(project.slug)}</p>
     <section class="card"><h2>Documents</h2><table><thead><tr><th>Title</th><th>Kind</th><th>Revision</th></tr></thead><tbody>${documents}</tbody></table></section>
     <section class="card"><h2>Works</h2><table><thead><tr><th>Title</th><th>Slug</th><th>State</th></tr></thead><tbody>${works}</tbody></table></section>`,
  );
}

function documentPage(store, projectSlug, identifier, revision) {
  const document = store.getDocument(projectSlug, identifier, revision);
  const revisions = store.listRevisions(projectSlug, identifier);
  return layout(
    document.title,
    `<p><a href="/projects/${encodeURIComponent(projectSlug)}">← Project</a></p>
     <h1>${escapeHtml(document.title)}</h1>
     <p class="meta">${escapeHtml(document.doc)} · revision ${document.revision} · ${escapeHtml(document.author)} · ${escapeHtml(document.updated_at)}</p>
     <div class="grid">
       <article class="card markdown">${renderMarkdown(document.body)}</article>
       <aside class="card"><h2>Revision history</h2><ol>${revisions
         .map(
           (item) =>
             `<li><a href="/projects/${encodeURIComponent(projectSlug)}/document?doc=${encodeURIComponent(identifier)}&revision=${item.revision}">revision ${item.revision}</a>
              <span class="meta">${escapeHtml(item.author)} · ${escapeHtml(item.created_at)}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</span></li>`,
         )
         .join("")}</ol></aside>
     </div>`,
  );
}

function participantRow(participant) {
  const badges = [
    participant.ball.has_ball ? '<span class="badge ball">has ball</span>' : "",
    participant.abandoned ? '<span class="badge danger">abandoned</span>' : "",
  ].join("");
  return `<tr><td>${escapeHtml(participant.identifier)}</td><td>${escapeHtml(participant.role)}</td>
    <td>${badges || '<span class="badge">waiting</span>'}</td>
    <td class="meta">${escapeHtml(participant.last_heartbeat_at ?? "no heartbeat")}</td></tr>`;
}

function messageCard(message, projectSlug, workSlug) {
  const answerForm =
    message.type === "question" && !message.closed_at && message.to.includes("owner")
      ? `<form method="post" action="/projects/${encodeURIComponent(projectSlug)}/works/${encodeURIComponent(workSlug)}/messages">
          <input type="hidden" name="type" value="answer">
          <input type="hidden" name="reply_to" value="${message.seq}">
          <input type="hidden" name="to" value="${escapeHtml(message.from)}">
          <label>Answer<textarea name="body" required></textarea></label>
          <button type="submit">Answer as owner</button>
        </form>`
      : "";
  return `<article class="card message ${escapeHtml(message.type)}">
    <div><span class="badge">${escapeHtml(message.type)} #${message.seq}</span>
      <strong>${escapeHtml(message.from)}</strong>
      ${message.closed_at ? '<span class="badge">closed</span>' : ""}</div>
    <p class="meta">to: ${escapeHtml(message.to.join(", ") || "—")} · reply_to: ${escapeHtml(message.reply_to ?? "—")} · ${escapeHtml(message.created_at)}</p>
    <div class="markdown">${renderMarkdown(message.body)}</div>
    ${message.refs.length ? `<p class="meta">refs: ${message.refs.map(escapeHtml).join(", ")}</p>` : ""}
    ${answerForm}
  </article>`;
}

function workPage(store, projectSlug, slug) {
  const work = store.getWork(projectSlug, slug);
  return layout(
    work.title,
    `<p><a href="/projects/${encodeURIComponent(work.project)}">← Project</a></p>
     <h1>${escapeHtml(work.title)}</h1>
     <p class="meta">${escapeHtml(work.slug)} · <span class="badge">${escapeHtml(work.state)}</span></p>
     <section class="card"><h2>Participants</h2><table><thead><tr><th>Identifier</th><th>Role</th><th>State</th><th>Heartbeat</th></tr></thead>
       <tbody>${work.participants.map(participantRow).join("")}</tbody></table></section>
     <section><h2>Conversation</h2>${work.messages.map((message) => messageCard(message, projectSlug, slug)).join("") || '<p class="card">No messages.</p>'}</section>
     <section class="card"><h2>Post as owner</h2>
       <form method="post" action="/projects/${encodeURIComponent(projectSlug)}/works/${encodeURIComponent(slug)}/messages">
         <label>Type<select name="type"><option value="message">message</option><option value="decision">decision</option></select></label>
         <label>Recipients (comma separated)<input name="to"></label>
         <label>Body<textarea name="body" required></textarea></label>
         <button type="submit">Post</button>
       </form>
     </section>`,
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
    if (!["message", "decision", "answer"].includes(type)) {
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
