import http from "node:http";
import { pathToFileURL } from "node:url";
import { createDatabase } from "./db.js";
import { AppError } from "./errors.js";
import { createStore } from "./store.js";
import { routeWeb } from "./web.js";

const DEFAULT_PORT = 7331;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      throw new AppError(413, "body_too_large", "Request body is too large");
    }
    chunks.push(chunk);
  }
  if (length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function integerQuery(url, name, fallback = 0) {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new AppError(400, "invalid_request", `${name} must be an integer`);
  }
  return value;
}

function booleanQuery(url, name, fallback = true) {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new AppError(
    400,
    "invalid_request",
    `${name} must be true or false`,
  );
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AppError(400, "invalid_path", "Path contains invalid encoding");
  }
}

async function routeApi(request, response, url, store) {
  const method = request.method;
  const path = url.pathname;

  if (method === "GET" && (path === "/health" || path === "/api/v1/health")) {
    json(response, 200, store.health());
    return true;
  }

  if (path === "/api/v1/rooms" && method === "GET") {
    json(response, 200, { rooms: store.listRooms() });
    return true;
  }

  if (path === "/api/v1/projects") {
    if (method === "GET") {
      json(response, 200, { projects: store.listProjects() });
      return true;
    }
    if (method === "POST") {
      json(response, 201, store.createProject(await readJson(request)));
      return true;
    }
  }

  if (path === "/api/v1/issues" && method === "GET") {
    json(response, 200, {
      projects: store.listIssuesAcrossProjects(
        url.searchParams.get("state") ?? "open",
      ),
    });
    return true;
  }

  let match = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
  if (match) {
    const project = decode(match[1]);
    if (method === "GET") {
      json(response, 200, store.getProject(project));
      return true;
    }
    if (method === "DELETE") {
      json(
        response,
        200,
        store.deleteProject(
          project,
          url.searchParams.get("confirm"),
          booleanQuery(url, "delete_nonempty", false),
        ),
      );
      return true;
    }
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/deletion-preview$/,
  );
  if (match && method === "GET") {
    json(response, 200, store.previewProjectDeletion(decode(match[1])));
    return true;
  }

  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/issues$/);
  if (match) {
    const project = decode(match[1]);
    if (method === "GET") {
      json(response, 200, {
        issues: store.listIssues(
          project,
          url.searchParams.get("state") ?? "open",
        ),
      });
      return true;
    }
    if (method === "POST") {
      json(response, 201, store.createIssue(project, await readJson(request)));
      return true;
    }
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/issues\/(\d+)\/comments$/,
  );
  if (match && method === "POST") {
    json(
      response,
      201,
      store.addIssueComment(
        decode(match[1]),
        Number(match[2]),
        await readJson(request),
      ),
    );
    return true;
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/issues\/(\d+)\/close$/,
  );
  if (match && method === "POST") {
    json(
      response,
      200,
      store.closeIssue(
        decode(match[1]),
        Number(match[2]),
        await readJson(request),
      ),
    );
    return true;
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/issues\/(\d+)\/reopen$/,
  );
  if (match && method === "POST") {
    json(
      response,
      200,
      store.reopenIssue(decode(match[1]), Number(match[2])),
    );
    return true;
  }

  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/issues\/(\d+)$/);
  if (match && method === "GET") {
    json(
      response,
      200,
      store.getIssue(decode(match[1]), Number(match[2])),
    );
    return true;
  }

  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/works$/);
  if (match && method === "POST") {
    json(response, 201, store.createWork(decode(match[1]), await readJson(request)));
    return true;
  }

  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/works\/([^/]+)$/);
  if (match) {
    const project = decode(match[1]);
    const work = decode(match[2]);
    if (method === "GET") {
      json(response, 200, store.getWork(project, work));
      return true;
    }
    if (method === "PATCH") {
      json(
        response,
        200,
        store.setWorkImplementer(project, work, await readJson(request)),
      );
      return true;
    }
    if (method === "DELETE") {
      json(
        response,
        200,
        store.deleteWork(
          project,
          work,
          url.searchParams.get("confirm"),
          booleanQuery(url, "delete_nonempty", false),
        ),
      );
      return true;
    }
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/works\/([^/]+)\/deletion-preview$/,
  );
  if (match && method === "GET") {
    json(
      response,
      200,
      store.previewWorkDeletion(decode(match[1]), decode(match[2])),
    );
    return true;
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/works\/([^/]+)\/participants\/([^/]+)$/,
  );
  if (match && method === "DELETE") {
    json(
      response,
      200,
      store.deleteParticipant(
        decode(match[1]),
        decode(match[2]),
        decode(match[3]),
      ),
    );
    return true;
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/works\/([^/]+)\/resolve$/,
  );
  if (match && method === "POST") {
    json(
      response,
      200,
      store.resolveWork(decode(match[1]), decode(match[2])),
    );
    return true;
  }

  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/documents$/);
  if (match) {
    const project = decode(match[1]);
    if (method === "GET") {
      json(response, 200, { documents: store.listDocuments(project) });
      return true;
    }
    if (method === "POST") {
      json(response, 201, store.createDocument(project, await readJson(request)));
      return true;
    }
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/documents\/(context|(?:adr|handoff)\/[^/]+)\/revisions\/(\d+)$/,
  );
  if (match && method === "GET") {
    json(
      response,
      200,
      store.getDocument(decode(match[1]), decode(match[2]), Number(match[3])),
    );
    return true;
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/documents\/(context|(?:adr|handoff)\/[^/]+)\/revisions$/,
  );
  if (match && method === "GET") {
    json(response, 200, {
      revisions: store.listRevisions(decode(match[1]), decode(match[2])),
    });
    return true;
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/documents\/(context|(?:adr|handoff)\/[^/]+)$/,
  );
  if (match) {
    const project = decode(match[1]);
    const document = decode(match[2]);
    if (method === "GET") {
      json(response, 200, store.getDocument(project, document));
      return true;
    }
    if (method === "PUT") {
      json(response, 200, store.updateDocument(project, document, await readJson(request)));
      return true;
    }
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/works\/([^/]+)\/messages$/,
  );
  if (match) {
    const project = decode(match[1]);
    const work = decode(match[2]);
    if (method === "GET") {
      json(response, 200, {
        messages: store.listMessages(
          project,
          work,
          integerQuery(url, "since"),
        ),
      });
      return true;
    }
    if (method === "POST") {
      json(
        response,
        201,
        store.postMessage(project, work, await readJson(request)),
      );
      return true;
    }
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/works\/([^/]+)\/messages\/(\d+)\/close$/,
  );
  if (match && method === "POST") {
    const body = await readJson(request);
    json(
      response,
      200,
      store.closeQuestion(
        decode(match[1]),
        decode(match[2]),
        Number(match[3]),
        body.from,
      ),
    );
    return true;
  }

  match = path.match(
    /^\/api\/v1\/projects\/([^/]+)\/works\/([^/]+)\/poll$/,
  );
  if (match && method === "GET") {
    json(
      response,
      200,
      store.poll(
        decode(match[1]),
        decode(match[2]),
        url.searchParams.get("as"),
        url.searchParams.get("role"),
        integerQuery(url, "since"),
        booleanQuery(url, "heartbeat"),
      ),
    );
    return true;
  }

  if (path === "/api/v1/inbox" && method === "GET") {
    json(response, 200, { questions: store.inbox(url.searchParams.get("as")) });
    return true;
  }

  if (path === "/api/v1/import" && method === "POST") {
    json(response, 201, store.importBundle(await readJson(request)));
    return true;
  }

  return false;
}

function sendError(response, error) {
  if (error instanceof AppError) {
    json(response, error.status, {
      error: error.code,
      message: error.message,
      ...(error.details ?? {}),
    });
    return;
  }
  console.error(error);
  json(response, 500, {
    error: "internal_error",
    message: "Internal server error",
  });
}

export function createHttpServer(options = {}) {
  const database = options.database ?? createDatabase(options.databasePath);
  const store = options.store ?? createStore(database, { clock: options.clock });
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const handled =
        (await routeApi(request, response, url, store)) ||
        (await routeWeb(request, response, url, store));
      if (!handled) {
        json(response, 404, { error: "not_found", message: "Route not found" });
      }
    } catch (error) {
      sendError(response, error);
    }
  });

  return { database, server, store };
}

export async function listen(options = {}) {
  const bind = options.bind ?? process.env.AO_BIND ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.AO_PORT ?? DEFAULT_PORT);
  const databasePath =
    options.databasePath ?? process.env.AO_DATABASE_PATH ?? "./data/ao.sqlite";
  const application = createHttpServer({ databasePath });
  await new Promise((resolve, reject) => {
    application.server.once("error", reject);
    application.server.listen(port, bind, resolve);
  });
  const warning =
    bind === "0.0.0.0"
      ? " WARNING: all container interfaces are in use; publish the Docker host port on 127.0.0.1 only."
      : "";
  console.log(`listening on ${bind}:${port}.${warning}`);
  return application;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  listen().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
