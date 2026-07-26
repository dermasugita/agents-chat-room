import { randomUUID } from "node:crypto";
import { AppError, assert } from "./errors.js";
import { databaseSchemaVersion, getDatabasePragmas, inTransaction } from "./db.js";

const MESSAGE_TYPES = new Set([
  "message",
  "question",
  "answer",
  "decision",
  "status",
  "resolve",
]);
const ROLES = new Set(["owner", "designer", "implementer"]);
const DOCUMENT_KINDS = new Set(["context", "adr", "handoff"]);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ABANDONED_AFTER_MS = 3 * 60 * 1_000;
const IDLE_AFTER_MS = 5 * 60 * 1_000;

function uniqueStrings(value, field) {
  assert(Array.isArray(value), 400, "invalid_request", `${field} must be an array`);
  const strings = value.map((item) => {
    assert(
      typeof item === "string" && item.length > 0,
      400,
      "invalid_request",
      `${field} entries must be non-empty strings`,
    );
    return item;
  });
  return [...new Set(strings)];
}

function kebabCase(value) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "decision";
}

function normalizeTime(value) {
  const parsed = new Date(value);
  assert(
    !Number.isNaN(parsed.getTime()),
    400,
    "invalid_request",
    `Invalid timestamp: ${value}`,
  );
  return parsed.toISOString();
}

export function createStore(database, options = {}) {
  const clock = options.clock ?? (() => new Date());
  const now = () => clock().toISOString();

  function requireSlug(value, field = "slug") {
    assert(
      typeof value === "string" && SLUG_PATTERN.test(value),
      400,
      "invalid_slug",
      `${field} must use lowercase letters, digits, and single hyphens`,
    );
    return value;
  }

  function projectBySlug(slug) {
    const project = database.prepare("SELECT * FROM project WHERE slug = ?").get(slug);
    assert(project, 404, "project_not_found", `Project not found: ${slug}`);
    return project;
  }

  function workBySlug(slug) {
    const work = database
      .prepare(
        `SELECT work.*, project.slug AS project_slug, project.name AS project_name
         FROM work JOIN project ON project.id = work.project_id
         WHERE work.slug = ?`,
      )
      .get(slug);
    assert(work, 404, "work_not_found", `Work not found: ${slug}`);
    return work;
  }

  function workInProject(projectId, slug) {
    const work = database
      .prepare("SELECT * FROM work WHERE project_id = ? AND slug = ?")
      .get(projectId, slug);
    assert(work, 404, "work_not_found", `Work not found: ${slug}`);
    return work;
  }

  function parseDocumentIdentifier(identifier) {
    if (identifier === "context") {
      return { kind: "context", slug: "context" };
    }
    const slash = identifier.indexOf("/");
    assert(slash > 0, 400, "invalid_document", `Invalid document identifier: ${identifier}`);
    const kind = identifier.slice(0, slash);
    const slug = identifier.slice(slash + 1);
    assert(
      kind === "adr" || kind === "handoff",
      400,
      "invalid_document",
      `Invalid document kind: ${kind}`,
    );
    requireSlug(slug, "document slug");
    return { kind, slug };
  }

  function documentIdentifier(row) {
    return row.kind === "context" ? "context" : `${row.kind}/${row.slug}`;
  }

  function documentRow(projectId, identifier) {
    const { kind, slug } = parseDocumentIdentifier(identifier);
    const document = database
      .prepare("SELECT * FROM document WHERE project_id = ? AND kind = ? AND slug = ?")
      .get(projectId, kind, slug);
    assert(
      document,
      404,
      "document_not_found",
      `Document not found: ${identifier}`,
    );
    return document;
  }

  function getMessageById(messageId) {
    const row = database.prepare("SELECT * FROM message WHERE id = ?").get(messageId);
    assert(row, 404, "message_not_found", "Message not found");
    return hydrateMessage(row);
  }

  function getMessageBySeq(workId, seq) {
    const row = database
      .prepare("SELECT * FROM message WHERE work_id = ? AND seq = ?")
      .get(workId, seq);
    assert(row, 404, "message_not_found", `Message not found: ${seq}`);
    return hydrateMessage(row);
  }

  function hydrateMessage(row) {
    const to = database
      .prepare("SELECT identifier FROM message_to WHERE message_id = ? ORDER BY identifier")
      .all(row.id)
      .map(({ identifier }) => identifier);
    const refs = database
      .prepare("SELECT ref FROM message_ref WHERE message_id = ? ORDER BY rowid")
      .all(row.id)
      .map(({ ref }) => ref);
    const expects = database
      .prepare(
        `SELECT document.kind, document.slug, message_expects.revision
         FROM message_expects
         JOIN document ON document.id = message_expects.document_id
         WHERE message_expects.message_id = ?
         ORDER BY document.kind, document.slug`,
      )
      .all(row.id)
      .map((expectation) => ({
        doc: documentIdentifier(expectation),
        revision: expectation.revision,
      }));
    const ball = row.has_ball_declaration
      ? database
          .prepare(
            "SELECT identifier FROM ball_declaration WHERE message_id = ? ORDER BY identifier",
          )
          .all(row.id)
          .map(({ identifier }) => identifier)
      : undefined;

    const message = {
      seq: row.seq,
      idempotency_key: row.idempotency_key,
      from: row.from_identifier,
      type: row.type,
      body: row.body,
      to,
      reply_to: row.reply_to_seq,
      refs,
      expects,
      closed_at: row.closed_at,
      created_at: row.created_at,
    };
    if (ball !== undefined) {
      message.ball = ball;
    }
    return message;
  }

  function registerParticipant(workId, identifier, role, seenAt) {
    const existing = database
      .prepare("SELECT role FROM participant WHERE work_id = ? AND identifier = ?")
      .get(workId, identifier);
    if (existing) {
      assert(
        existing.role === role,
        409,
        "participant_role_conflict",
        `${identifier} is already registered as ${existing.role}`,
      );
      return;
    }
    database
      .prepare(
        `INSERT INTO participant(
           work_id, identifier, role, first_seen_at, last_heartbeat_at
         ) VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(workId, identifier, role, seenAt);
  }

  function ballFor(workId, identifier) {
    const unanswered = database
      .prepare(
        `SELECT question.seq, question.from_identifier
         FROM message AS question
         JOIN message_to ON message_to.message_id = question.id
         WHERE question.work_id = ?
           AND question.type = 'question'
           AND question.closed_at IS NULL
           AND message_to.identifier = ?
           AND NOT EXISTS (
             SELECT 1
             FROM message AS answer
             WHERE answer.work_id = question.work_id
               AND answer.type = 'answer'
               AND answer.reply_to_seq = question.seq
               AND answer.from_identifier = ?
           )
         ORDER BY question.seq`,
      )
      .all(workId, identifier, identifier)
      .map((question) => ({
        kind: "unanswered_question",
        seq: question.seq,
        from: question.from_identifier,
      }));

    const declarationMessage = database
      .prepare(
        `SELECT id, seq, from_identifier
         FROM message
         WHERE work_id = ? AND has_ball_declaration = 1
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(workId);
    const declared =
      declarationMessage &&
      database
        .prepare(
          "SELECT 1 FROM ball_declaration WHERE message_id = ? AND identifier = ?",
        )
        .get(declarationMessage.id, identifier)
        ? [
            {
              kind: "declared",
              seq: declarationMessage.seq,
              by: declarationMessage.from_identifier,
            },
          ]
        : [];

    const reasons = [...unanswered, ...declared];
    return { has_ball: reasons.length > 0, reasons };
  }

  function staleExpectations(workId, identifier) {
    const latest = database
      .prepare(
        `SELECT message.id
         FROM message
         WHERE message.work_id = ?
           AND message.from_identifier = ?
           AND EXISTS (
             SELECT 1 FROM message_expects
             WHERE message_expects.message_id = message.id
           )
         ORDER BY message.seq DESC
         LIMIT 1`,
      )
      .get(workId, identifier);
    if (!latest) {
      return [];
    }

    return database
      .prepare(
        `SELECT document.kind, document.slug,
                message_expects.revision AS you_have,
                document.current_revision AS current
         FROM message_expects
         JOIN document ON document.id = message_expects.document_id
         WHERE message_expects.message_id = ?
           AND message_expects.revision < document.current_revision
         ORDER BY document.kind, document.slug`,
      )
      .all(latest.id)
      .map((row) => ({
        doc: documentIdentifier(row),
        you_have: row.you_have,
        current: row.current,
      }));
  }

  function participantStates(workId, omitIdentifier = undefined) {
    const cutoff = clock().getTime() - ABANDONED_AFTER_MS;
    return database
      .prepare("SELECT * FROM participant WHERE work_id = ? ORDER BY identifier")
      .all(workId)
      .filter((participant) => participant.identifier !== omitIdentifier)
      .map((participant) => {
        const ball = ballFor(workId, participant.identifier);
        const heartbeat = participant.last_heartbeat_at ?? participant.first_seen_at;
        const abandoned =
          participant.role !== "owner" &&
          ball.has_ball &&
          new Date(heartbeat).getTime() < cutoff;
        return {
          identifier: participant.identifier,
          role: participant.role,
          first_seen_at: participant.first_seen_at,
          last_heartbeat_at: participant.last_heartbeat_at,
          ball,
          abandoned,
        };
      });
  }

  function health() {
    return {
      status: "ok",
      api_version: "v1",
      schema_version: databaseSchemaVersion,
      pragmas: getDatabasePragmas(database),
    };
  }

  function listProjects() {
    return database
      .prepare(
        `SELECT project.*,
                (SELECT COUNT(*) FROM work WHERE work.project_id = project.id) AS work_count,
                (SELECT COUNT(*) FROM document WHERE document.project_id = project.id) AS document_count
         FROM project
         ORDER BY project.slug`,
      )
      .all();
  }

  function createProject(input) {
    const slug = requireSlug(input?.slug);
    assert(
      typeof input?.name === "string" && input.name.trim(),
      400,
      "invalid_request",
      "name is required",
    );
    if (database.prepare("SELECT 1 FROM project WHERE slug = ?").get(slug)) {
      throw new AppError(409, "project_exists", `Project already exists: ${slug}`);
    }
    const createdAt = now();
    const result = database
      .prepare("INSERT INTO project(slug, name, created_at) VALUES (?, ?, ?)")
      .run(slug, input.name.trim(), createdAt);
    return database.prepare("SELECT * FROM project WHERE id = ?").get(result.lastInsertRowid);
  }

  function getProject(slug) {
    const project = projectBySlug(slug);
    const works = database
      .prepare(
        `SELECT slug, title, state, created_at
         FROM work WHERE project_id = ? ORDER BY slug`,
      )
      .all(project.id);
    const documents = listDocuments(slug);
    return { ...project, works, documents };
  }

  function createWork(projectSlug, input) {
    const project = projectBySlug(projectSlug);
    const slug = requireSlug(input?.slug);
    assert(
      typeof input?.title === "string" && input.title.trim(),
      400,
      "invalid_request",
      "title is required",
    );
    if (
      database
        .prepare("SELECT 1 FROM work WHERE project_id = ? AND slug = ?")
        .get(project.id, slug)
    ) {
      throw new AppError(409, "work_exists", `Work already exists: ${slug}`);
    }
    const result = database
      .prepare(
        `INSERT INTO work(project_id, slug, title, state, created_at)
         VALUES (?, ?, ?, 'open', ?)`,
      )
      .run(project.id, slug, input.title.trim(), now());
    return database.prepare("SELECT * FROM work WHERE id = ?").get(result.lastInsertRowid);
  }

  function resolveWork(workSlug) {
    const work = workBySlug(workSlug);
    database.prepare("UPDATE work SET state = 'resolved' WHERE id = ?").run(work.id);
    return { ...work, state: "resolved" };
  }

  function listDocuments(projectSlug) {
    const project = projectBySlug(projectSlug);
    return database
      .prepare(
        `SELECT kind, slug, title, current_revision, created_at
         FROM document WHERE project_id = ?
         ORDER BY CASE kind WHEN 'context' THEN 0 WHEN 'adr' THEN 1 ELSE 2 END,
                  adr_number, slug`,
      )
      .all(project.id)
      .map((document) => ({
        doc: documentIdentifier(document),
        ...document,
      }));
  }

  function getDocument(projectSlug, identifier, revisionNumber = undefined) {
    const project = projectBySlug(projectSlug);
    const document = documentRow(project.id, identifier);
    const revision =
      revisionNumber === undefined
        ? database
            .prepare(
              "SELECT * FROM revision WHERE document_id = ? AND revision = ?",
            )
            .get(document.id, document.current_revision)
        : database
            .prepare(
              "SELECT * FROM revision WHERE document_id = ? AND revision = ?",
            )
            .get(document.id, revisionNumber);
    assert(
      revision,
      404,
      "revision_not_found",
      `Revision not found: ${revisionNumber}`,
    );
    return {
      doc: documentIdentifier(document),
      kind: document.kind,
      slug: document.slug,
      title: document.title,
      body: revision.body,
      revision: revision.revision,
      updated_at: revision.created_at,
      author: revision.author,
      note: revision.note,
    };
  }

  function listRevisions(projectSlug, identifier) {
    const project = projectBySlug(projectSlug);
    const document = documentRow(project.id, identifier);
    return database
      .prepare(
        `SELECT revision, author, note, created_at
         FROM revision WHERE document_id = ? ORDER BY revision DESC`,
      )
      .all(document.id);
  }

  function createDocument(projectSlug, input) {
    const project = projectBySlug(projectSlug);
    assert(
      DOCUMENT_KINDS.has(input?.kind),
      400,
      "invalid_request",
      "kind must be context, adr, or handoff",
    );
    assert(
      typeof input?.title === "string" && input.title.trim(),
      400,
      "invalid_request",
      "title is required",
    );
    assert(typeof input?.body === "string", 400, "invalid_request", "body is required");
    assert(
      typeof input?.author === "string" && input.author,
      400,
      "invalid_request",
      "author is required",
    );

    return inTransaction(database, () => {
      let slug;
      let adrNumber = null;
      let workId = null;
      if (input.kind === "context") {
        assert(
          !database
            .prepare("SELECT 1 FROM document WHERE project_id = ? AND kind = 'context'")
            .get(project.id),
          409,
          "context_exists",
          "A project can contain only one CONTEXT document",
        );
        slug = "context";
      } else if (input.kind === "adr") {
        assert(
          input.slug === undefined,
          400,
          "invalid_request",
          "ADR slug is assigned by the server",
        );
        adrNumber =
          database
            .prepare(
              "SELECT COALESCE(MAX(adr_number), 0) + 1 AS next FROM document WHERE project_id = ? AND kind = 'adr'",
            )
            .get(project.id).next;
        slug = `${String(adrNumber).padStart(4, "0")}-${kebabCase(input.title)}`;
      } else {
        slug = requireSlug(input.slug, "handoff slug");
        workId = workInProject(project.id, slug).id;
      }

      assert(
        !database
          .prepare(
            "SELECT 1 FROM document WHERE project_id = ? AND kind = ? AND slug = ?",
          )
          .get(project.id, input.kind, slug),
        409,
        "document_exists",
        `Document already exists: ${input.kind}/${slug}`,
      );

      const createdAt = now();
      const result = database
        .prepare(
          `INSERT INTO document(
             project_id, kind, slug, work_id, adr_number, title, current_revision, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          project.id,
          input.kind,
          slug,
          workId,
          adrNumber,
          input.title.trim(),
          createdAt,
        );
      database
        .prepare(
          `INSERT INTO revision(
             document_id, revision, body, author, note, created_at
           ) VALUES (?, 1, ?, ?, ?, ?)`,
        )
        .run(
          result.lastInsertRowid,
          input.body,
          input.author,
          input.note ?? null,
          createdAt,
        );
      return getDocument(projectSlug, documentIdentifier({ kind: input.kind, slug }));
    });
  }

  function updateDocument(projectSlug, identifier, input) {
    const project = projectBySlug(projectSlug);
    assert(typeof input?.body === "string", 400, "invalid_request", "body is required");
    assert(
      Number.isInteger(input?.base_revision) && input.base_revision > 0,
      400,
      "invalid_request",
      "base_revision must be a positive integer",
    );
    assert(
      typeof input?.author === "string" && input.author,
      400,
      "invalid_request",
      "author is required",
    );

    return inTransaction(database, () => {
      const document = documentRow(project.id, identifier);
      if (input.base_revision !== document.current_revision) {
        const current = database
          .prepare(
            "SELECT body FROM revision WHERE document_id = ? AND revision = ?",
          )
          .get(document.id, document.current_revision);
        throw new AppError(409, "revision_conflict", "Document revision conflict", {
          current_revision: document.current_revision,
          current_body: current.body,
        });
      }

      const nextRevision = document.current_revision + 1;
      const updatedAt = now();
      database
        .prepare(
          `INSERT INTO revision(
             document_id, revision, body, author, note, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          document.id,
          nextRevision,
          input.body,
          input.author,
          input.note ?? null,
          updatedAt,
        );
      database
        .prepare("UPDATE document SET current_revision = ? WHERE id = ?")
        .run(nextRevision, document.id);
      return {
        revision: nextRevision,
        updated_at: updatedAt,
      };
    });
  }

  function postMessage(workSlug, input) {
    const work = workBySlug(workSlug);
    assert(
      typeof input?.idempotency_key === "string" && input.idempotency_key,
      400,
      "invalid_request",
      "idempotency_key is required",
    );

    const existing = database
      .prepare("SELECT id FROM message WHERE work_id = ? AND idempotency_key = ?")
      .get(work.id, input.idempotency_key);
    if (existing) {
      return getMessageById(existing.id);
    }

    assert(
      typeof input.from === "string" && input.from,
      400,
      "invalid_request",
      "from is required",
    );
    assert(ROLES.has(input.role), 400, "invalid_request", "role is invalid");
    assert(MESSAGE_TYPES.has(input.type), 400, "invalid_request", "type is invalid");
    assert(typeof input.body === "string", 400, "invalid_request", "body is required");
    const to = uniqueStrings(input.to ?? [], "to");
    const refs = uniqueStrings(input.refs ?? [], "refs");
    const hasBallDeclaration = Object.hasOwn(input, "ball");
    const ball = hasBallDeclaration ? uniqueStrings(input.ball, "ball") : [];
    const expects = input.expects ?? [];
    assert(Array.isArray(expects), 400, "invalid_request", "expects must be an array");
    assert(
      input.type !== "question" || to.length > 0,
      400,
      "question_requires_recipient",
      "question messages require at least one recipient",
    );
    assert(
      input.type !== "answer" || Number.isInteger(input.reply_to),
      400,
      "answer_requires_reply",
      "answer messages require reply_to",
    );
    if (input.reply_to !== undefined && input.reply_to !== null) {
      assert(
        Number.isInteger(input.reply_to) && input.reply_to > 0,
        400,
        "invalid_request",
        "reply_to must be a positive integer",
      );
    }

    const createdAt = now();
    const messageId = inTransaction(database, () => {
      const duplicate = database
        .prepare("SELECT id FROM message WHERE work_id = ? AND idempotency_key = ?")
        .get(work.id, input.idempotency_key);
      if (duplicate) {
        return duplicate.id;
      }

      if (input.type === "answer") {
        const question = database
          .prepare(
            "SELECT type FROM message WHERE work_id = ? AND seq = ?",
          )
          .get(work.id, input.reply_to);
        assert(
          question?.type === "question",
          400,
          "invalid_reply",
          "reply_to must identify a question in the same work",
        );
      }

      const resolvedExpects = expects.map((expectation) => {
        assert(
          expectation &&
            typeof expectation.doc === "string" &&
            Number.isInteger(expectation.revision) &&
            expectation.revision > 0,
          400,
          "invalid_request",
          "expects entries require doc and a positive revision",
        );
        return {
          document: documentRow(work.project_id, expectation.doc),
          revision: expectation.revision,
        };
      });
      assert(
        new Set(resolvedExpects.map(({ document }) => document.id)).size ===
          resolvedExpects.length,
        400,
        "invalid_request",
        "expects cannot repeat a document",
      );

      registerParticipant(work.id, input.from, input.role, createdAt);
      const seq = database
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM message WHERE work_id = ?",
        )
        .get(work.id).next;
      const result = database
        .prepare(
          `INSERT INTO message(
             work_id, seq, idempotency_key, from_identifier, type, body,
             reply_to_seq, closed_at, has_ball_declaration, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          work.id,
          seq,
          input.idempotency_key,
          input.from,
          input.type,
          input.body,
          input.reply_to ?? null,
          hasBallDeclaration ? 1 : 0,
          createdAt,
        );
      for (const identifier of to) {
        database
          .prepare("INSERT INTO message_to(message_id, identifier) VALUES (?, ?)")
          .run(result.lastInsertRowid, identifier);
      }
      for (const ref of refs) {
        database
          .prepare("INSERT INTO message_ref(message_id, ref) VALUES (?, ?)")
          .run(result.lastInsertRowid, ref);
      }
      for (const expectation of resolvedExpects) {
        database
          .prepare(
            `INSERT INTO message_expects(message_id, document_id, revision)
             VALUES (?, ?, ?)`,
          )
          .run(result.lastInsertRowid, expectation.document.id, expectation.revision);
      }
      for (const identifier of ball) {
        database
          .prepare(
            "INSERT INTO ball_declaration(message_id, identifier) VALUES (?, ?)",
          )
          .run(result.lastInsertRowid, identifier);
      }
      return result.lastInsertRowid;
    });
    return getMessageById(messageId);
  }

  function listMessages(workSlug, since = 0) {
    const work = workBySlug(workSlug);
    assert(
      Number.isInteger(since) && since >= 0,
      400,
      "invalid_request",
      "since must be a non-negative integer",
    );
    return database
      .prepare("SELECT * FROM message WHERE work_id = ? AND seq > ? ORDER BY seq")
      .all(work.id, since)
      .map(hydrateMessage);
  }

  function closeQuestion(workSlug, seq, from) {
    const work = workBySlug(workSlug);
    assert(typeof from === "string" && from, 400, "invalid_request", "from is required");
    const question = database
      .prepare("SELECT * FROM message WHERE work_id = ? AND seq = ?")
      .get(work.id, seq);
    assert(question, 404, "message_not_found", `Message not found: ${seq}`);
    assert(
      question.type === "question",
      400,
      "not_a_question",
      `Message ${seq} is not a question`,
    );
    assert(
      question.from_identifier === from,
      403,
      "close_forbidden",
      "Only the question author can close it",
    );
    const closedAt = question.closed_at ?? now();
    database
      .prepare("UPDATE message SET closed_at = ? WHERE id = ?")
      .run(closedAt, question.id);
    return { seq, closed_at: closedAt };
  }

  function poll(workSlug, identifier, role = "implementer", since = 0) {
    const work = workBySlug(workSlug);
    assert(typeof identifier === "string" && identifier, 400, "invalid_request", "as is required");
    assert(ROLES.has(role), 400, "invalid_request", "role is invalid");
    assert(
      Number.isInteger(since) && since >= 0,
      400,
      "invalid_request",
      "since must be a non-negative integer",
    );
    const heartbeatAt = now();
    inTransaction(database, () => {
      registerParticipant(work.id, identifier, role, heartbeatAt);
      if (role !== "owner") {
        database
          .prepare(
            `UPDATE participant SET last_heartbeat_at = ?
             WHERE work_id = ? AND identifier = ?`,
          )
          .run(heartbeatAt, work.id, identifier);
      }
    });

    const yourBall = ballFor(work.id, identifier);
    const latest = database
      .prepare("SELECT created_at FROM message WHERE work_id = ? ORDER BY seq DESC LIMIT 1")
      .get(work.id);
    const latestActivity = latest?.created_at ?? work.created_at;
    const idle =
      !yourBall.has_ball &&
      new Date(latestActivity).getTime() < clock().getTime() - IDLE_AFTER_MS;
    const abandoned = participantStates(work.id, identifier)
      .filter((participant) => participant.abandoned)
      .map((participant) => ({
        identifier: participant.identifier,
        last_heartbeat_at: participant.last_heartbeat_at,
        ball_reasons: participant.ball.reasons,
      }));

    return {
      messages: listMessages(workSlug, since),
      your_ball: yourBall,
      idle_nudge: idle
        ? "No participant has acted for 5 minutes and you do not hold the ball. Re-check the work state or ask who should act next."
        : null,
      abandoned,
      stale_expectations: staleExpectations(work.id, identifier),
      heartbeat_at: role === "owner" ? null : heartbeatAt,
    };
  }

  function inbox(identifier) {
    assert(typeof identifier === "string" && identifier, 400, "invalid_request", "as is required");
    const rows = database
      .prepare(
        `SELECT question.*, work.slug AS work_slug, project.slug AS project_slug
         FROM message AS question
         JOIN message_to ON message_to.message_id = question.id
         JOIN work ON work.id = question.work_id
         JOIN project ON project.id = work.project_id
         WHERE question.type = 'question'
           AND question.closed_at IS NULL
           AND message_to.identifier = ?
           AND NOT EXISTS (
             SELECT 1
             FROM message AS answer
             WHERE answer.work_id = question.work_id
               AND answer.type = 'answer'
               AND answer.reply_to_seq = question.seq
               AND answer.from_identifier = ?
           )
         ORDER BY question.created_at, question.seq`,
      )
      .all(identifier, identifier);
    return rows.map((row) => ({
      project: row.project_slug,
      work: row.work_slug,
      message: hydrateMessage(row),
    }));
  }

  function getWork(workSlug) {
    const work = workBySlug(workSlug);
    return {
      slug: work.slug,
      title: work.title,
      state: work.state,
      created_at: work.created_at,
      project: work.project_slug,
      participants: participantStates(work.id),
      messages: listMessages(workSlug),
    };
  }

  function seedImportedMessage(workSlug, input) {
    const idempotencyKey = input.idempotency_key ?? `import:${randomUUID()}`;
    return postMessage(workSlug, { ...input, idempotency_key: idempotencyKey });
  }

  return {
    ballFor,
    closeQuestion,
    createDocument,
    createProject,
    createWork,
    getDocument,
    getProject,
    getWork,
    health,
    inbox,
    listDocuments,
    listMessages,
    listProjects,
    listRevisions,
    participantStates,
    poll,
    postMessage,
    resolveWork,
    seedImportedMessage,
    updateDocument,
    _database: database,
    _normalizeTime: normalizeTime,
  };
}

export const timing = {
  abandonedAfterMs: ABANDONED_AFTER_MS,
  idleAfterMs: IDLE_AFTER_MS,
};
