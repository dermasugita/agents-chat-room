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
const ATTENDANCE_MODES = new Set(["self-driven", "on-demand"]);
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

function attendanceModeFromStatus(input) {
  if (input.type !== "status" || typeof input.body !== "string") {
    return undefined;
  }
  const schedule = input.body.match(
    /(?:^|\s)schedule=(registered|unavailable)(?=[:(\s]|$)/,
  )?.[1];
  if (schedule === "registered") {
    return "self-driven";
  }
  if (schedule === "unavailable") {
    return "on-demand";
  }
  return undefined;
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

  function workBySlug(projectSlug, slug) {
    const project = projectBySlug(projectSlug);
    const work = database
      .prepare(
        `SELECT work.*, project.slug AS project_slug, project.name AS project_name
         FROM work JOIN project ON project.id = work.project_id
         WHERE work.project_id = ? AND work.slug = ?`,
      )
      .get(project.id, slug);
    assert(
      work,
      404,
      "work_not_found",
      `Work not found: ${projectSlug}/${slug}`,
    );
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
      .prepare(
        "SELECT role FROM participant WHERE work_id = ? AND identifier = ?",
      )
      .get(workId, identifier);
    if (existing) {
      assert(
        existing.role === role,
        409,
        "participant_role_conflict",
        `${identifier} is registered as ${existing.role}; requested role was ${role}`,
        {
          registered_role: existing.role,
          requested_role: role,
        },
      );
      return;
    }
    const inheritedAttendance = database
      .prepare(
        `SELECT project_participant.attendance_mode
         FROM work AS current_work
         JOIN work AS project_work
           ON project_work.project_id = current_work.project_id
         JOIN participant AS project_participant
           ON project_participant.work_id = project_work.id
         WHERE current_work.id = ?
           AND project_participant.identifier = ?
         LIMIT 1`,
      )
      .get(workId, identifier)?.attendance_mode;
    database
      .prepare(
        `INSERT INTO participant(
           work_id, identifier, role, attendance_mode,
           first_seen_at, last_heartbeat_at
         ) VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        workId,
        identifier,
        role,
        inheritedAttendance ?? "self-driven",
        seenAt,
      );
  }

  function touchParticipant(workId, identifier, role, seenAt) {
    registerParticipant(workId, identifier, role, seenAt);
    if (role !== "owner") {
      database
        .prepare(
          `UPDATE participant SET last_heartbeat_at = ?
           WHERE work_id = ? AND identifier = ?`,
        )
        .run(seenAt, workId, identifier);
    }
  }

  function setAttendanceMode(workId, identifier, attendanceMode) {
    assert(
      ATTENDANCE_MODES.has(attendanceMode),
      400,
      "invalid_request",
      "attendance_mode is invalid",
    );
    database
      .prepare(
        `UPDATE participant
         SET attendance_mode = ?
         WHERE identifier = ?
           AND work_id IN (
             SELECT project_work.id
             FROM work AS current_work
             JOIN work AS project_work
               ON project_work.project_id = current_work.project_id
             WHERE current_work.id = ?
           )`,
      )
      .run(attendanceMode, identifier, workId);
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
        const projectActivity = database
          .prepare(
            `SELECT MAX(
               COALESCE(project_participant.last_heartbeat_at,
                        project_participant.first_seen_at)
             ) AS latest
             FROM work AS current_work
             JOIN work AS project_work
               ON project_work.project_id = current_work.project_id
             JOIN participant AS project_participant
               ON project_participant.work_id = project_work.id
             WHERE current_work.id = ?
               AND project_participant.identifier = ?`,
          )
          .get(workId, participant.identifier).latest;
        const staleWithBall =
          participant.role !== "owner" &&
          ball.has_ball &&
          new Date(projectActivity ?? heartbeat).getTime() < cutoff;
        const abandoned =
          staleWithBall && participant.attendance_mode === "self-driven";
        const awaitingActivation =
          staleWithBall && participant.attendance_mode === "on-demand";
        return {
          identifier: participant.identifier,
          role: participant.role,
          attendance_mode: participant.attendance_mode,
          first_seen_at: participant.first_seen_at,
          last_heartbeat_at: participant.last_heartbeat_at,
          present:
            participant.last_heartbeat_at !== null &&
            new Date(participant.last_heartbeat_at).getTime() >= cutoff,
          ball,
          abandoned,
          awaiting_activation: awaitingActivation,
        };
      });
  }

  function expectedParticipant(work) {
    if (!work.expected_participant_identifier) {
      return null;
    }
    return {
      identifier: work.expected_participant_identifier,
      role: work.expected_participant_role,
    };
  }

  function serializeWork(work) {
    const {
      expected_participant_identifier: _expectedIdentifier,
      expected_participant_role: _expectedRole,
      ...serialized
    } = work;
    return {
      ...serialized,
      expected_participant: expectedParticipant(work),
    };
  }

  function requireIssueIdentity(input) {
    const originProject = requireSlug(input?.origin_project, "origin_project");
    assert(
      typeof input?.origin_identifier === "string" &&
        input.origin_identifier.trim(),
      400,
      "invalid_request",
      "origin_identifier is required",
    );
    assert(
      ROLES.has(input?.origin_role),
      400,
      "invalid_request",
      "origin_role is invalid",
    );
    const originWork =
      input?.origin_work === undefined || input.origin_work === null
        ? null
        : requireSlug(input.origin_work, "origin_work");
    return {
      origin_project: originProject,
      origin_identifier: input.origin_identifier.trim(),
      origin_role: input.origin_role,
      origin_work: originWork,
    };
  }

  function requireIssueNumber(value) {
    const number = Number(value);
    assert(
      Number.isInteger(number) && number > 0,
      400,
      "invalid_request",
      "issue number must be a positive integer",
    );
    return number;
  }

  function requireIssueState(value = "open") {
    assert(
      value === "open" || value === "closed" || value === "all",
      400,
      "invalid_request",
      "state must be open, closed, or all",
    );
    return value;
  }

  function issueByNumber(projectSlug, requestedNumber) {
    const project = projectBySlug(projectSlug);
    const number = requireIssueNumber(requestedNumber);
    const issue = database
      .prepare(
        `SELECT issue.*, project.slug AS project_slug, project.name AS project_name
         FROM issue JOIN project ON project.id = issue.project_id
         WHERE issue.project_id = ? AND issue.number = ?`,
      )
      .get(project.id, number);
    assert(
      issue,
      404,
      "issue_not_found",
      `Issue not found: ${projectSlug}#${number}`,
    );
    return issue;
  }

  function serializeIssue(row, comments = undefined) {
    const {
      id: _id,
      project_id: _projectId,
      project_slug: project,
      project_name: projectName,
      ...issue
    } = row;
    return {
      project,
      project_name: projectName,
      ...issue,
      ...(comments === undefined ? {} : { comments }),
    };
  }

  function serializeIssueComment(row) {
    const { id: _id, issue_id: _issueId, ...comment } = row;
    return comment;
  }

  function createIssue(projectSlug, input) {
    const project = projectBySlug(projectSlug);
    assert(
      typeof input?.title === "string" && input.title.trim(),
      400,
      "invalid_request",
      "title is required",
    );
    assert(
      typeof input?.body === "string",
      400,
      "invalid_request",
      "body is required",
    );
    const identity = requireIssueIdentity(input);
    return inTransaction(database, () => {
      const number = database
        .prepare(
          "SELECT COALESCE(MAX(number), 0) + 1 AS next FROM issue WHERE project_id = ?",
        )
        .get(project.id).next;
      database
        .prepare(
          `INSERT INTO issue(
             project_id, number, title, body, state,
             origin_project, origin_identifier, origin_role, origin_work,
             created_at, closed_at, closed_by, close_reason
           ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          project.id,
          number,
          input.title.trim(),
          input.body,
          identity.origin_project,
          identity.origin_identifier,
          identity.origin_role,
          identity.origin_work,
          now(),
        );
      return serializeIssue(issueByNumber(projectSlug, number));
    });
  }

  function listIssues(projectSlug, state = "open") {
    const project = projectBySlug(projectSlug);
    const selectedState = requireIssueState(state);
    const rows = database
      .prepare(
        `SELECT issue.*, project.slug AS project_slug, project.name AS project_name
         FROM issue JOIN project ON project.id = issue.project_id
         WHERE issue.project_id = ?
           AND (? = 'all' OR issue.state = ?)
         ORDER BY issue.number`,
      )
      .all(project.id, selectedState, selectedState);
    return rows.map((row) => serializeIssue(row));
  }

  function listIssuesAcrossProjects(state = "open") {
    const selectedState = requireIssueState(state);
    const rows = database
      .prepare(
        `SELECT issue.*, project.slug AS project_slug, project.name AS project_name
         FROM issue JOIN project ON project.id = issue.project_id
         WHERE ? = 'all' OR issue.state = ?
         ORDER BY project.slug, issue.number`,
      )
      .all(selectedState, selectedState);
    const projects = [];
    for (const row of rows) {
      let group = projects.at(-1);
      if (!group || group.project.slug !== row.project_slug) {
        group = {
          project: { slug: row.project_slug, name: row.project_name },
          issues: [],
        };
        projects.push(group);
      }
      group.issues.push(serializeIssue(row));
    }
    return projects;
  }

  function getIssue(projectSlug, requestedNumber) {
    const issue = issueByNumber(projectSlug, requestedNumber);
    const comments = database
      .prepare(
        "SELECT * FROM issue_comment WHERE issue_id = ? ORDER BY seq",
      )
      .all(issue.id)
      .map(serializeIssueComment);
    return serializeIssue(issue, comments);
  }

  function addIssueComment(projectSlug, requestedNumber, input) {
    const issue = issueByNumber(projectSlug, requestedNumber);
    assert(
      typeof input?.body === "string" && input.body.trim(),
      400,
      "invalid_request",
      "body is required",
    );
    const identity = requireIssueIdentity(input);
    return inTransaction(database, () => {
      const seq = database
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM issue_comment WHERE issue_id = ?",
        )
        .get(issue.id).next;
      const result = database
        .prepare(
          `INSERT INTO issue_comment(
             issue_id, seq, body, origin_project, origin_identifier,
             origin_role, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          issue.id,
          seq,
          input.body,
          identity.origin_project,
          identity.origin_identifier,
          identity.origin_role,
          now(),
        );
      return serializeIssueComment(
        database
          .prepare("SELECT * FROM issue_comment WHERE id = ?")
          .get(result.lastInsertRowid),
      );
    });
  }

  function closeIssue(projectSlug, requestedNumber, input) {
    const issue = issueByNumber(projectSlug, requestedNumber);
    assert(
      typeof input?.reason === "string" && input.reason.trim(),
      400,
      "invalid_request",
      "reason is required",
    );
    const identity = requireIssueIdentity(input);
    assert(
      issue.state === "open",
      409,
      "issue_already_closed",
      `Issue is already closed: ${projectSlug}#${issue.number}`,
    );
    database
      .prepare(
        `UPDATE issue
         SET state = 'closed', closed_at = ?, closed_by = ?, close_reason = ?
         WHERE id = ?`,
      )
      .run(
        now(),
        `${identity.origin_project}/${identity.origin_identifier}`,
        input.reason.trim(),
        issue.id,
      );
    return getIssue(projectSlug, issue.number);
  }

  function reopenIssue(projectSlug, requestedNumber) {
    const issue = issueByNumber(projectSlug, requestedNumber);
    assert(
      issue.state === "closed",
      409,
      "issue_already_open",
      `Issue is already open: ${projectSlug}#${issue.number}`,
    );
    database
      .prepare(
        `UPDATE issue
         SET state = 'open', closed_at = NULL, closed_by = NULL, close_reason = NULL
         WHERE id = ?`,
      )
      .run(issue.id);
    return getIssue(projectSlug, issue.number);
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
                (SELECT COUNT(*) FROM document WHERE document.project_id = project.id) AS document_count,
                (SELECT COUNT(*) FROM issue WHERE issue.project_id = project.id) AS issue_count,
                (SELECT COUNT(*) FROM issue
                 WHERE issue.project_id = project.id AND issue.state = 'open') AS open_issue_count
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
        `SELECT slug, title, state, expected_participant_identifier,
                expected_participant_role, created_at
         FROM work WHERE project_id = ? ORDER BY slug`,
      )
      .all(project.id)
      .map(serializeWork);
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
    const implementer =
      input?.implementer === undefined || input.implementer === null
        ? null
        : String(input.implementer).trim();
    assert(
      implementer === null || implementer.length > 0,
      400,
      "invalid_request",
      "implementer must be a non-empty identifier",
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
        `INSERT INTO work(
           project_id, slug, title, state,
           expected_participant_identifier, expected_participant_role, created_at
         )
         VALUES (?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(
        project.id,
        slug,
        input.title.trim(),
        implementer,
        implementer === null ? null : "implementer",
        now(),
      );
    return serializeWork(
      database.prepare("SELECT * FROM work WHERE id = ?").get(result.lastInsertRowid),
    );
  }

  function setWorkImplementer(projectSlug, workSlug, input) {
    const work = workBySlug(projectSlug, workSlug);
    const implementer =
      input?.implementer === undefined || input.implementer === null
        ? ""
        : String(input.implementer).trim();
    assert(
      implementer.length > 0,
      400,
      "invalid_request",
      "implementer must be a non-empty identifier",
    );
    database
      .prepare(
        `UPDATE work
         SET expected_participant_identifier = ?,
             expected_participant_role = 'implementer'
         WHERE id = ?`,
      )
      .run(implementer, work.id);
    return getWork(projectSlug, workSlug);
  }

  function resolveWork(projectSlug, workSlug) {
    const work = workBySlug(projectSlug, workSlug);
    database.prepare("UPDATE work SET state = 'resolved' WHERE id = ?").run(work.id);
    return serializeWork({ ...work, state: "resolved" });
  }

  function emptyDeletionCounts() {
    return {
      projects: 0,
      works: 0,
      messages: 0,
      participants: 0,
      documents: 0,
      revisions: 0,
      issues: 0,
      issue_comments: 0,
      message_recipients: 0,
      message_refs: 0,
      message_expectations: 0,
      ball_declarations: 0,
    };
  }

  function deletedRows(sql, ...parameters) {
    return Number(database.prepare(sql).run(...parameters).changes);
  }

  function requireDeletionConfirmation(slug, confirmation) {
    assert(
      confirmation === slug,
      400,
      "confirmation_required",
      `confirm must exactly match the target slug: ${slug}`,
      { expected_confirm: slug },
    );
  }

  function deleteDocument(projectSlug, identifier, confirmation) {
    requireDeletionConfirmation(identifier, confirmation);
    return inTransaction(database, () => {
      const project = projectBySlug(projectSlug);
      const document = documentRow(project.id, identifier);
      const deleted = emptyDeletionCounts();
      deleted.message_expectations = deletedRows(
        "DELETE FROM message_expects WHERE document_id = ?",
        document.id,
      );
      deleted.revisions = deletedRows(
        "DELETE FROM revision WHERE document_id = ?",
        document.id,
      );
      deleted.documents = deletedRows(
        "DELETE FROM document WHERE id = ?",
        document.id,
      );
      return {
        target: { project: projectSlug, document: identifier },
        deleted,
      };
    });
  }

  function workDeletionSummary(work) {
    const messageActivity = database
      .prepare(
        `SELECT COUNT(*) AS message_count, MAX(created_at) AS last_message_at
         FROM message WHERE work_id = ?`,
      )
      .get(work.id);
    const heartbeatParticipants = database
      .prepare(
        `SELECT identifier, last_heartbeat_at
         FROM participant
         WHERE work_id = ? AND last_heartbeat_at IS NOT NULL
         ORDER BY identifier`,
      )
      .all(work.id);
    const documentCounts = database
      .prepare(
        `SELECT COUNT(DISTINCT document.id) AS document_count,
                COUNT(revision.id) AS revision_count
         FROM document
         LEFT JOIN revision ON revision.document_id = document.id
         WHERE document.work_id = ?`,
      )
      .get(work.id);
    const participantCount = Number(
      database
        .prepare("SELECT COUNT(*) AS count FROM participant WHERE work_id = ?")
        .get(work.id).count,
    );
    return {
      slug: work.slug,
      title: work.title,
      message_count: Number(messageActivity.message_count),
      last_updated_at: messageActivity.last_message_at ?? work.created_at,
      heartbeat_participants: heartbeatParticipants,
      participant_count: participantCount,
      document_count: Number(documentCounts.document_count),
      revision_count: Number(documentCounts.revision_count),
    };
  }

  function previewProjectDeletion(projectSlug) {
    const project = projectBySlug(projectSlug);
    const works = database
      .prepare("SELECT * FROM work WHERE project_id = ? ORDER BY slug")
      .all(project.id)
      .map(workDeletionSummary);
    const projectDocumentCounts = database
      .prepare(
        `SELECT COUNT(DISTINCT document.id) AS document_count,
                COUNT(revision.id) AS revision_count
         FROM document
         LEFT JOIN revision ON revision.document_id = document.id
         WHERE document.project_id = ?`,
      )
      .get(project.id);
    const issueCounts = database
      .prepare(
        `SELECT COUNT(DISTINCT issue.id) AS issue_count,
                COUNT(issue_comment.id) AS comment_count
         FROM issue
         LEFT JOIN issue_comment ON issue_comment.issue_id = issue.id
         WHERE issue.project_id = ?`,
      )
      .get(project.id);
    // origin_project is plain text, so issues filed elsewhere from this project
    // survive the delete with an origin that no longer resolves. They are not
    // deleted, but the owner must see them before confirming.
    const foreignIssuesFromHere = database
      .prepare(
        `SELECT COUNT(*) AS count FROM issue
         WHERE origin_project = ? AND project_id <> ?`,
      )
      .get(projectSlug, project.id);
    return {
      target: { project: projectSlug },
      totals: {
        projects: 1,
        works: works.length,
        messages: works.reduce((total, work) => total + work.message_count, 0),
        participants: works.reduce(
          (total, work) => total + work.participant_count,
          0,
        ),
        documents: Number(projectDocumentCounts.document_count),
        revisions: Number(projectDocumentCounts.revision_count),
        issues: Number(issueCounts.issue_count),
        issue_comments: Number(issueCounts.comment_count),
      },
      retained: {
        issues_in_other_projects_citing_this_origin: Number(
          foreignIssuesFromHere.count,
        ),
      },
      works,
    };
  }

  function previewWorkDeletion(projectSlug, workSlug) {
    const work = workBySlug(projectSlug, workSlug);
    const summary = workDeletionSummary(work);
    return {
      target: { project: projectSlug, work: workSlug },
      totals: {
        projects: 0,
        works: 1,
        messages: summary.message_count,
        participants: summary.participant_count,
        documents: summary.document_count,
        revisions: summary.revision_count,
      },
      works: [summary],
    };
  }

  function requireNonemptyDeletionOverride(preview, deleteNonempty) {
    assert(
      preview.totals.messages === 0 || deleteNonempty === true,
      409,
      "nonempty_delete_requires_override",
      "Target contains messages; pass the separate delete_nonempty override to delete it",
      {
        required_override: "delete_nonempty=true",
        deletion_preview: preview,
      },
    );
  }

  function deleteProject(projectSlug, confirmation, deleteNonempty = false) {
    requireDeletionConfirmation(projectSlug, confirmation);
    return inTransaction(database, () => {
      const project = projectBySlug(projectSlug);
      requireNonemptyDeletionOverride(
        previewProjectDeletion(projectSlug),
        deleteNonempty,
      );
      const deleted = emptyDeletionCounts();
      const messageIds = `
        SELECT message.id
        FROM message
        JOIN work ON work.id = message.work_id
        WHERE work.project_id = ?
      `;
      const documentIds =
        "SELECT id FROM document WHERE project_id = ?";
      const workIds = "SELECT id FROM work WHERE project_id = ?";
      const issueIds = "SELECT id FROM issue WHERE project_id = ?";

      deleted.issue_comments = deletedRows(
        `DELETE FROM issue_comment WHERE issue_id IN (${issueIds})`,
        project.id,
      );
      deleted.issues = deletedRows(
        "DELETE FROM issue WHERE project_id = ?",
        project.id,
      );
      deleted.message_recipients = deletedRows(
        `DELETE FROM message_to WHERE message_id IN (${messageIds})`,
        project.id,
      );
      deleted.message_refs = deletedRows(
        `DELETE FROM message_ref WHERE message_id IN (${messageIds})`,
        project.id,
      );
      deleted.ball_declarations = deletedRows(
        `DELETE FROM ball_declaration WHERE message_id IN (${messageIds})`,
        project.id,
      );
      deleted.message_expectations = deletedRows(
        `DELETE FROM message_expects
         WHERE message_id IN (${messageIds})
            OR document_id IN (${documentIds})`,
        project.id,
        project.id,
      );
      deleted.messages = deletedRows(
        `DELETE FROM message WHERE id IN (${messageIds})`,
        project.id,
      );
      deleted.revisions = deletedRows(
        `DELETE FROM revision WHERE document_id IN (${documentIds})`,
        project.id,
      );
      deleted.participants = deletedRows(
        `DELETE FROM participant WHERE work_id IN (${workIds})`,
        project.id,
      );
      deleted.documents = deletedRows(
        "DELETE FROM document WHERE project_id = ?",
        project.id,
      );
      deleted.works = deletedRows(
        "DELETE FROM work WHERE project_id = ?",
        project.id,
      );
      deleted.projects = deletedRows(
        "DELETE FROM project WHERE id = ?",
        project.id,
      );

      return {
        target: { project: projectSlug },
        deleted,
      };
    });
  }

  function deleteWork(
    projectSlug,
    workSlug,
    confirmation,
    deleteNonempty = false,
  ) {
    requireDeletionConfirmation(workSlug, confirmation);
    return inTransaction(database, () => {
      const work = workBySlug(projectSlug, workSlug);
      requireNonemptyDeletionOverride(
        previewWorkDeletion(projectSlug, workSlug),
        deleteNonempty,
      );
      const deleted = emptyDeletionCounts();
      const messageIds = "SELECT id FROM message WHERE work_id = ?";
      const documentIds = "SELECT id FROM document WHERE work_id = ?";

      deleted.message_recipients = deletedRows(
        `DELETE FROM message_to WHERE message_id IN (${messageIds})`,
        work.id,
      );
      deleted.message_refs = deletedRows(
        `DELETE FROM message_ref WHERE message_id IN (${messageIds})`,
        work.id,
      );
      deleted.ball_declarations = deletedRows(
        `DELETE FROM ball_declaration WHERE message_id IN (${messageIds})`,
        work.id,
      );
      deleted.message_expectations = deletedRows(
        `DELETE FROM message_expects
         WHERE message_id IN (${messageIds})
            OR document_id IN (${documentIds})`,
        work.id,
        work.id,
      );
      deleted.messages = deletedRows(
        "DELETE FROM message WHERE work_id = ?",
        work.id,
      );
      deleted.revisions = deletedRows(
        `DELETE FROM revision WHERE document_id IN (${documentIds})`,
        work.id,
      );
      deleted.participants = deletedRows(
        "DELETE FROM participant WHERE work_id = ?",
        work.id,
      );
      deleted.documents = deletedRows(
        "DELETE FROM document WHERE work_id = ?",
        work.id,
      );
      deleted.works = deletedRows("DELETE FROM work WHERE id = ?", work.id);

      return {
        target: { project: projectSlug, work: workSlug },
        deleted,
      };
    });
  }

  function deleteParticipant(projectSlug, workSlug, identifier) {
    assert(
      typeof identifier === "string" && identifier.length > 0,
      400,
      "invalid_request",
      "participant identifier is required",
    );
    return inTransaction(database, () => {
      const work = workBySlug(projectSlug, workSlug);
      const participant = database
        .prepare(
          `SELECT id FROM participant
           WHERE work_id = ? AND identifier = ?`,
        )
        .get(work.id, identifier);
      assert(
        participant,
        404,
        "participant_not_found",
        `Participant not found: ${projectSlug}/${workSlug}/${identifier}`,
      );
      const messageCount = Number(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM message
             WHERE work_id = ? AND from_identifier = ?`,
          )
          .get(work.id, identifier).count,
      );
      assert(
        messageCount === 0,
        409,
        "participant_has_messages",
        `Participant cannot be deleted after posting messages: ${identifier}`,
        { message_count: messageCount },
      );
      const deleted = emptyDeletionCounts();
      deleted.participants = deletedRows(
        "DELETE FROM participant WHERE id = ?",
        participant.id,
      );
      return {
        target: {
          project: projectSlug,
          work: workSlug,
          participant: identifier,
        },
        deleted,
      };
    });
  }

  function listRooms() {
    return database
      .prepare(
        `SELECT work.*, project.slug AS project_slug, project.name AS project_name
         FROM work
         JOIN project ON project.id = work.project_id
         ORDER BY project.slug, work.slug`,
      )
      .all()
      .map((work) => {
        const expected = expectedParticipant(work);
        const participant = expected
          ? participantStates(work.id).find(
              ({ identifier }) => identifier === expected.identifier,
            )
          : undefined;
        return {
          project: {
            slug: work.project_slug,
            name: work.project_name,
          },
          work: {
            slug: work.slug,
            title: work.title,
            state: work.state,
          },
          expected_participant: expected,
          presence: expected
            ? {
                registered: participant !== undefined,
                present: participant?.present ?? false,
                first_seen_at: participant?.first_seen_at ?? null,
                last_heartbeat_at: participant?.last_heartbeat_at ?? null,
                attendance_mode:
                  participant?.attendance_mode ?? "self-driven",
                ball: participant?.ball ?? { has_ball: false, reasons: [] },
                abandoned: participant?.abandoned ?? false,
                awaiting_activation:
                  participant?.awaiting_activation ?? false,
              }
            : null,
        };
      });
  }

  function listDocuments(projectSlug) {
    const project = projectBySlug(projectSlug);
    return database
      .prepare(
        `SELECT kind, slug, adr_number, title, current_revision, created_at
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
      adr_number: document.adr_number,
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
        const explicitNumber =
          input.adr_number === undefined || input.adr_number === null
            ? null
            : input.adr_number;
        assert(
          explicitNumber === null ||
            (Number.isInteger(explicitNumber) && explicitNumber > 0),
          400,
          "invalid_request",
          "adr_number must be a positive integer",
        );
        adrNumber =
          explicitNumber ??
          database
            .prepare(
              "SELECT COALESCE(MAX(adr_number), 0) + 1 AS next FROM document WHERE project_id = ? AND kind = 'adr'",
            )
            .get(project.id).next;
        const numberPrefix = String(adrNumber).padStart(4, "0");
        if (input.slug === undefined) {
          slug = `${numberPrefix}-${kebabCase(input.title)}`;
        } else {
          assert(
            explicitNumber !== null,
            400,
            "invalid_request",
            "An explicit ADR slug requires adr_number",
          );
          slug = requireSlug(input.slug, "ADR slug");
          assert(
            slug.startsWith(`${numberPrefix}-`),
            400,
            "invalid_request",
            `ADR slug must start with ${numberPrefix}-`,
          );
        }
        assert(
          !database
            .prepare(
              "SELECT 1 FROM document WHERE project_id = ? AND kind = 'adr' AND adr_number = ?",
            )
            .get(project.id, adrNumber),
          409,
          "adr_number_conflict",
          `ADR number already exists: ${adrNumber}`,
        );
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

  function postMessage(projectSlug, workSlug, input) {
    const work = workBySlug(projectSlug, workSlug);
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

      touchParticipant(work.id, input.from, input.role, createdAt);
      const attendanceMode = attendanceModeFromStatus(input);
      if (attendanceMode !== undefined) {
        setAttendanceMode(work.id, input.from, attendanceMode);
      }
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

  function listMessages(projectSlug, workSlug, since = 0) {
    const work = workBySlug(projectSlug, workSlug);
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

  function closeQuestion(projectSlug, workSlug, seq, from) {
    const work = workBySlug(projectSlug, workSlug);
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

  function poll(
    projectSlug,
    workSlug,
    identifier,
    role = undefined,
    since = 0,
    heartbeat = true,
  ) {
    const work = workBySlug(projectSlug, workSlug);
    assert(typeof identifier === "string" && identifier, 400, "invalid_request", "as is required");
    if (role !== undefined && role !== null) {
      assert(ROLES.has(role), 400, "invalid_request", "role is invalid");
    }
    assert(
      Number.isInteger(since) && since >= 0,
      400,
      "invalid_request",
      "since must be a non-negative integer",
    );
    assert(
      typeof heartbeat === "boolean",
      400,
      "invalid_request",
      "heartbeat must be a boolean",
    );
    const participant = database
      .prepare("SELECT role FROM participant WHERE work_id = ? AND identifier = ?")
      .get(work.id, identifier);
    assert(
      participant || ROLES.has(role),
      400,
      "role_required",
      "role is required when registering a new participant",
    );
    assert(
      !participant || role === undefined || role === null || participant.role === role,
      409,
      "participant_role_conflict",
      `${identifier} is registered as ${participant?.role}; requested role was ${role}`,
      {
        registered_role: participant?.role,
        requested_role: role,
      },
    );
    const effectiveRole = participant?.role ?? role;
    const polledAt = now();
    inTransaction(database, () => {
      if (heartbeat) {
        touchParticipant(work.id, identifier, effectiveRole, polledAt);
      } else {
        registerParticipant(work.id, identifier, effectiveRole, polledAt);
      }
    });
    const heartbeatAt = database
      .prepare(
        `SELECT last_heartbeat_at
         FROM participant WHERE work_id = ? AND identifier = ?`,
      )
      .get(work.id, identifier).last_heartbeat_at;

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
    const awaitingActivation = participantStates(work.id, identifier)
      .filter((participant) => participant.awaiting_activation)
      .map((participant) => ({
        identifier: participant.identifier,
        last_heartbeat_at: participant.last_heartbeat_at,
        ball_reasons: participant.ball.reasons,
      }));

    return {
      messages: listMessages(projectSlug, workSlug, since),
      your_ball: yourBall,
      idle_nudge: idle
        ? "No participant has acted for 5 minutes and you do not hold the ball. Re-check the work state or ask who should act next."
        : null,
      abandoned,
      awaiting_activation: awaitingActivation,
      stale_expectations: staleExpectations(work.id, identifier),
      heartbeat_at: heartbeatAt,
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

  function activationInbox() {
    return database
      .prepare(
        `SELECT work.id, work.slug AS work_slug, project.slug AS project_slug
         FROM work
         JOIN project ON project.id = work.project_id
         ORDER BY project.slug, work.slug`,
      )
      .all()
      .flatMap((work) =>
        participantStates(work.id)
          .filter((participant) => participant.awaiting_activation)
          .map((participant) => ({
            project: work.project_slug,
            work: work.work_slug,
            identifier: participant.identifier,
            role: participant.role,
            attendance_mode: participant.attendance_mode,
            last_heartbeat_at: participant.last_heartbeat_at,
            ball_reasons: participant.ball.reasons,
          })),
      );
  }

  function getWork(projectSlug, workSlug) {
    const work = workBySlug(projectSlug, workSlug);
    return {
      slug: work.slug,
      title: work.title,
      state: work.state,
      created_at: work.created_at,
      project: work.project_slug,
      expected_participant: expectedParticipant(work),
      participants: participantStates(work.id),
      messages: listMessages(projectSlug, workSlug),
    };
  }

  function seedImportedMessage(projectSlug, workSlug, input) {
    const idempotencyKey = input.idempotency_key ?? `import:${randomUUID()}`;
    return postMessage(projectSlug, workSlug, {
      ...input,
      idempotency_key: idempotencyKey,
    });
  }

  function inferImportedRole(identifier) {
    const normalized = identifier.toLowerCase();
    if (normalized.includes("owner")) {
      return { role: "owner", uncertain: false };
    }
    if (normalized.includes("designer") || normalized.includes("design")) {
      return { role: "designer", uncertain: false };
    }
    if (
      normalized.includes("implementer") ||
      normalized.includes("impl")
    ) {
      return { role: "implementer", uncertain: false };
    }
    return { role: "implementer", uncertain: true };
  }

  function importBundle(input) {
    assert(input?.project, 400, "invalid_request", "project is required");
    const requestedSlug = requireSlug(input.project.slug, "project slug");
    assert(
      typeof input.project.name === "string" && input.project.name.trim(),
      400,
      "invalid_request",
      "project name is required",
    );
    const documents = input.documents ?? [];
    const works = input.works ?? [];
    const sessions = input.sessions ?? [];
    assert(Array.isArray(documents), 400, "invalid_request", "documents must be an array");
    assert(Array.isArray(works), 400, "invalid_request", "works must be an array");
    assert(Array.isArray(sessions), 400, "invalid_request", "sessions must be an array");

    const validationErrors = [];
    for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex += 1) {
      const session = sessions[sessionIndex];
      if (!session || typeof session !== "object" || Array.isArray(session)) {
        validationErrors.push({
          source: "session",
          session: sessionIndex + 1,
          work: null,
          line: null,
          id: null,
          field: "session",
          value: session ?? null,
          message: "Session must be an object",
        });
        continue;
      }
      const work =
        typeof session.work_slug === "string" ? session.work_slug : null;
      if (!work || !SLUG_PATTERN.test(work)) {
        validationErrors.push({
          source: "session",
          session: sessionIndex + 1,
          work,
          line: null,
          id: null,
          field: "work_slug",
          value: session.work_slug ?? null,
          message:
            "session work slug must use lowercase letters, digits, and single hyphens",
        });
      }
      if (!Array.isArray(session.messages)) {
        validationErrors.push({
          source: "session",
          session: sessionIndex + 1,
          work,
          line: null,
          id: null,
          field: "messages",
          value: session.messages ?? null,
          message: "Session messages must be an array",
        });
        continue;
      }
      for (let index = 0; index < session.messages.length; index += 1) {
        const source = session.messages[index];
        const location = {
          source: "session",
          session: sessionIndex + 1,
          work,
          line: index + 1,
          id:
            source &&
            typeof source === "object" &&
            typeof source.id === "string"
              ? source.id
              : null,
        };
        if (!source || typeof source !== "object" || Array.isArray(source)) {
          validationErrors.push({
            ...location,
            field: "message",
            value: source ?? null,
            message: "Session message must be an object",
          });
          continue;
        }
        for (const field of ["ts", "closed_at"]) {
          if (!source[field]) {
            continue;
          }
          try {
            normalizeTime(source[field]);
          } catch (error) {
            validationErrors.push({
              ...location,
              field,
              value: source[field],
              message: error.message,
            });
          }
        }
      }
    }
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      if (!document?.created_at) {
        continue;
      }
      try {
        normalizeTime(document.created_at);
      } catch (error) {
        validationErrors.push({
          source: "document",
          document: index + 1,
          doc:
            document.kind === "context"
              ? "context"
              : `${document.kind ?? "unknown"}/${document.slug ?? "unknown"}`,
          line: null,
          id: null,
          field: "created_at",
          value: document.created_at,
          message: error.message,
        });
      }
    }
    if (validationErrors.length > 0) {
      throw new AppError(
        400,
        "import_validation_failed",
        `Import validation failed for ${validationErrors.length} field(s); no data was written`,
        { errors: validationErrors },
      );
    }

    return inTransaction(database, () => {
      const importedAt = now();
      let project = database
        .prepare("SELECT * FROM project WHERE slug = ?")
        .get(requestedSlug);
      let projectSlug = requestedSlug;
      if (project && !input.reuse_project) {
        let suffix = 2;
        while (
          database
            .prepare("SELECT 1 FROM project WHERE slug = ?")
            .get(`${requestedSlug}-import-${suffix}`)
        ) {
          suffix += 1;
        }
        projectSlug = `${requestedSlug}-import-${suffix}`;
        project = undefined;
      }
      if (!project) {
        const result = database
          .prepare("INSERT INTO project(slug, name, created_at) VALUES (?, ?, ?)")
          .run(projectSlug, input.project.name.trim(), importedAt);
        project = database
          .prepare("SELECT * FROM project WHERE id = ?")
          .get(result.lastInsertRowid);
      }

      const workDefinitions = new Map();
      for (const work of works) {
        const slug = requireSlug(work.slug, "work slug");
        workDefinitions.set(slug, {
          slug,
          state: work.state === "resolved" ? "resolved" : "open",
          title:
            typeof work.title === "string" && work.title.trim()
              ? work.title.trim()
              : slug,
        });
      }
      for (const session of sessions) {
        const slug = requireSlug(session.work_slug, "session work slug");
        if (!workDefinitions.has(slug)) {
          workDefinitions.set(slug, {
            slug,
            state: "open",
            title:
              typeof session.title === "string" && session.title.trim()
                ? session.title.trim()
                : slug,
          });
        }
      }
      for (const document of documents.filter(({ kind }) => kind === "handoff")) {
        const slug = requireSlug(
          document.work_slug ?? document.slug,
          "handoff work slug",
        );
        if (!workDefinitions.has(slug)) {
          workDefinitions.set(slug, {
            slug,
            state: "open",
            title: document.title || slug,
          });
        }
      }

      const workRows = new Map();
      for (const definition of workDefinitions.values()) {
        let row = database
          .prepare("SELECT * FROM work WHERE project_id = ? AND slug = ?")
          .get(project.id, definition.slug);
        if (!row) {
          const result = database
            .prepare(
              `INSERT INTO work(project_id, slug, title, state, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              project.id,
              definition.slug,
              definition.title,
              definition.state,
              importedAt,
            );
          row = database
            .prepare("SELECT * FROM work WHERE id = ?")
            .get(result.lastInsertRowid);
        }
        workRows.set(definition.slug, row);
      }

      const report = {
        project: project.slug,
        documents: 0,
        works: workRows.size,
        messages: 0,
        uncertain_roles: [],
        mapped_types: [],
        skipped_documents: [],
        unresolved_replies: [],
      };

      for (const imported of documents) {
        assert(
          DOCUMENT_KINDS.has(imported.kind),
          400,
          "invalid_request",
          `Invalid imported document kind: ${imported.kind}`,
        );
        assert(
          typeof imported.title === "string" && imported.title.trim(),
          400,
          "invalid_request",
          "Imported documents require a title",
        );
        assert(
          typeof imported.body === "string",
          400,
          "invalid_request",
          "Imported documents require a body",
        );
        let slug;
        let adrNumber = null;
        let workId = null;
        if (imported.kind === "context") {
          slug = "context";
        } else if (imported.kind === "adr") {
          slug = requireSlug(imported.slug, "ADR slug");
          adrNumber = Number(imported.adr_number);
          assert(
            Number.isInteger(adrNumber) && adrNumber > 0,
            400,
            "invalid_request",
            "Imported ADRs require their original positive adr_number",
          );
        } else {
          slug = requireSlug(imported.slug, "handoff slug");
          workId = workRows.get(imported.work_slug ?? slug)?.id;
          assert(workId, 400, "invalid_request", `Missing work for handoff: ${slug}`);
        }
        const existing = database
          .prepare(
            "SELECT 1 FROM document WHERE project_id = ? AND kind = ? AND slug = ?",
          )
          .get(project.id, imported.kind, slug);
        if (existing) {
          report.skipped_documents.push(
            documentIdentifier({ kind: imported.kind, slug }),
          );
          continue;
        }
        if (
          imported.kind === "context" &&
          database
            .prepare("SELECT 1 FROM document WHERE project_id = ? AND kind = 'context'")
            .get(project.id)
        ) {
          report.skipped_documents.push("context");
          continue;
        }
        assert(
          imported.kind !== "adr" ||
            !database
              .prepare(
                "SELECT 1 FROM document WHERE project_id = ? AND adr_number = ?",
              )
              .get(project.id, adrNumber),
          409,
          "adr_number_conflict",
          `ADR number already exists: ${adrNumber}`,
        );
        const createdAt = imported.created_at
          ? normalizeTime(imported.created_at)
          : importedAt;
        const result = database
          .prepare(
            `INSERT INTO document(
               project_id, kind, slug, work_id, adr_number, title, current_revision, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
          )
          .run(
            project.id,
            imported.kind,
            slug,
            workId,
            adrNumber,
            imported.title.trim(),
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
            imported.body,
            imported.author || "import",
            imported.note ?? "Imported from file-based workflow",
            createdAt,
          );
        report.documents += 1;
      }

      for (const session of sessions) {
        const work = workRows.get(session.work_slug);
        assert(work, 400, "invalid_request", `Missing work: ${session.work_slug}`);
        assert(
          Array.isArray(session.messages),
          400,
          "invalid_request",
          "Session messages must be an array",
        );
        const startingSeq = database
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM message WHERE work_id = ?",
          )
          .get(work.id).next;
        const sourceIds = new Map();
        session.messages.forEach((message, index) => {
          const sourceId =
            typeof message.id === "string" && message.id
              ? message.id
              : `line-${index + 1}`;
          const indexes = sourceIds.get(sourceId) ?? [];
          indexes.push(index);
          sourceIds.set(sourceId, indexes);
        });

        for (let index = 0; index < session.messages.length; index += 1) {
          const source = session.messages[index];
          const sourceId =
            typeof source.id === "string" && source.id
              ? source.id
              : `line-${index + 1}`;
          const from =
            typeof source.from === "string" && source.from
              ? source.from
              : "unknown-importer";
          const inferred = inferImportedRole(from);
          if (inferred.uncertain && !report.uncertain_roles.includes(from)) {
            report.uncertain_roles.push(from);
          }
          const sourceType = source.type;
          const type = MESSAGE_TYPES.has(sourceType) ? sourceType : "message";
          if (type !== sourceType) {
            report.mapped_types.push({
              line: index + 1,
              original: sourceType ?? null,
              work: session.work_slug,
            });
          }
          let replyToSeq = null;
          let unresolvedReply = null;
          if (source.reply_to !== undefined && source.reply_to !== null) {
            const targets = sourceIds.get(String(source.reply_to)) ?? [];
            if (targets.length === 1) {
              replyToSeq = startingSeq + targets[0];
            } else {
              unresolvedReply = String(source.reply_to);
              report.unresolved_replies.push({
                line: index + 1,
                reply_to: unresolvedReply,
                work: session.work_slug,
              });
            }
          }
          const createdAt = source.ts ? normalizeTime(source.ts) : importedAt;
          const seq = startingSeq + index;
          const result = database
            .prepare(
              `INSERT INTO message(
                 work_id, seq, idempotency_key, from_identifier, type, body,
                 reply_to_seq, closed_at, has_ball_declaration, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              work.id,
              seq,
              `import:${randomUUID()}`,
              from,
              type,
              typeof source.body === "string" ? source.body : String(source.body ?? ""),
              replyToSeq,
              source.closed_at ? normalizeTime(source.closed_at) : null,
              Object.hasOwn(source, "ball") ? 1 : 0,
              createdAt,
            );
          const messageId = result.lastInsertRowid;
          database
            .prepare(
              `INSERT INTO participant(
                 work_id, identifier, role, first_seen_at, last_heartbeat_at
               ) VALUES (?, ?, ?, ?, NULL)
               ON CONFLICT(work_id, identifier) DO NOTHING`,
            )
            .run(work.id, from, inferred.role, createdAt);
          for (const identifier of [
            ...new Set(Array.isArray(source.to) ? source.to.filter((item) => typeof item === "string" && item) : []),
          ]) {
            database
              .prepare("INSERT INTO message_to(message_id, identifier) VALUES (?, ?)")
              .run(messageId, identifier);
          }
          const refs = Array.isArray(source.refs)
            ? source.refs.filter((item) => typeof item === "string" && item)
            : [];
          for (const ref of refs) {
            database
              .prepare("INSERT INTO message_ref(message_id, ref) VALUES (?, ?)")
              .run(messageId, ref);
          }
          database
            .prepare("INSERT INTO message_ref(message_id, ref) VALUES (?, ?)")
            .run(messageId, `imported-id:${sourceId}`);
          if (unresolvedReply) {
            database
              .prepare("INSERT INTO message_ref(message_id, ref) VALUES (?, ?)")
              .run(messageId, `unresolved-reply-to:${unresolvedReply}`);
          }
          if (Array.isArray(source.ball)) {
            for (const identifier of [
              ...new Set(
                source.ball.filter((item) => typeof item === "string" && item),
              ),
            ]) {
              database
                .prepare(
                  "INSERT INTO ball_declaration(message_id, identifier) VALUES (?, ?)",
                )
                .run(messageId, identifier);
            }
          }
          if (Array.isArray(source.expects)) {
            for (const expectation of source.expects) {
              if (
                !expectation ||
                typeof expectation.doc !== "string" ||
                !Number.isInteger(expectation.revision)
              ) {
                continue;
              }
              let importedDocument;
              try {
                importedDocument = documentRow(project.id, expectation.doc);
              } catch {
                continue;
              }
              database
                .prepare(
                  `INSERT OR IGNORE INTO message_expects(
                     message_id, document_id, revision
                   ) VALUES (?, ?, ?)`,
                )
                .run(messageId, importedDocument.id, expectation.revision);
            }
          }
          report.messages += 1;
        }
      }
      return report;
    });
  }

  return {
    addIssueComment,
    activationInbox,
    ballFor,
    closeQuestion,
    closeIssue,
    createDocument,
    createIssue,
    createProject,
    createWork,
    deleteDocument,
    deleteParticipant,
    deleteProject,
    deleteWork,
    getDocument,
    getIssue,
    getProject,
    getWork,
    health,
    inbox,
    importBundle,
    listDocuments,
    listIssues,
    listIssuesAcrossProjects,
    listMessages,
    listProjects,
    listRevisions,
    listRooms,
    participantStates,
    poll,
    postMessage,
    previewProjectDeletion,
    previewWorkDeletion,
    resolveWork,
    reopenIssue,
    setWorkImplementer,
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
