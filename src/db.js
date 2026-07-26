import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  version     INTEGER NOT NULL,
  migrated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work (
  id                              INTEGER PRIMARY KEY,
  project_id                      INTEGER NOT NULL REFERENCES project(id),
  slug                            TEXT NOT NULL,
  title                           TEXT NOT NULL,
  state                           TEXT NOT NULL CHECK (state IN ('open','resolved')),
  expected_participant_identifier TEXT,
  expected_participant_role       TEXT CHECK (
    expected_participant_role IN ('owner','designer','implementer')
  ),
  created_at                      TEXT NOT NULL,
  CHECK (
    (expected_participant_identifier IS NULL AND expected_participant_role IS NULL)
    OR
    (expected_participant_identifier IS NOT NULL AND expected_participant_role IS NOT NULL)
  ),
  UNIQUE (project_id, slug)
);

CREATE TABLE IF NOT EXISTS document (
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES project(id),
  kind             TEXT NOT NULL CHECK (kind IN ('context','adr','handoff')),
  slug             TEXT NOT NULL,
  work_id          INTEGER REFERENCES work(id),
  adr_number       INTEGER,
  title            TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (project_id, kind, slug)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_single_context
  ON document(project_id) WHERE kind = 'context';
CREATE UNIQUE INDEX IF NOT EXISTS idx_adr_number
  ON document(project_id, adr_number) WHERE kind = 'adr';

CREATE TABLE IF NOT EXISTS revision (
  id          INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES document(id),
  revision    INTEGER NOT NULL,
  body        TEXT NOT NULL,
  author      TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (document_id, revision)
);

CREATE TABLE IF NOT EXISTS participant (
  id                INTEGER PRIMARY KEY,
  work_id           INTEGER NOT NULL REFERENCES work(id),
  identifier        TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('owner','designer','implementer')),
  first_seen_at     TEXT NOT NULL,
  last_heartbeat_at TEXT,
  UNIQUE (work_id, identifier)
);

CREATE TABLE IF NOT EXISTS message (
  id                   INTEGER PRIMARY KEY,
  work_id              INTEGER NOT NULL REFERENCES work(id),
  seq                  INTEGER NOT NULL,
  idempotency_key      TEXT NOT NULL,
  from_identifier      TEXT NOT NULL,
  type                 TEXT NOT NULL
                       CHECK (type IN ('message','question','answer','decision','status','resolve')),
  body                 TEXT NOT NULL,
  reply_to_seq         INTEGER,
  closed_at            TEXT,
  has_ball_declaration INTEGER NOT NULL DEFAULT 0 CHECK (has_ball_declaration IN (0,1)),
  created_at           TEXT NOT NULL,
  UNIQUE (work_id, seq),
  UNIQUE (work_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS message_to (
  message_id INTEGER NOT NULL REFERENCES message(id),
  identifier TEXT NOT NULL,
  PRIMARY KEY (message_id, identifier)
);

CREATE TABLE IF NOT EXISTS message_ref (
  message_id INTEGER NOT NULL REFERENCES message(id),
  ref        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_expects (
  message_id  INTEGER NOT NULL REFERENCES message(id),
  document_id INTEGER NOT NULL REFERENCES document(id),
  revision    INTEGER NOT NULL,
  PRIMARY KEY (message_id, document_id)
);

CREATE TABLE IF NOT EXISTS ball_declaration (
  message_id INTEGER NOT NULL REFERENCES message(id),
  identifier TEXT NOT NULL,
  PRIMARY KEY (message_id, identifier)
);

CREATE INDEX IF NOT EXISTS idx_message_work_seq ON message(work_id, seq);
CREATE INDEX IF NOT EXISTS idx_message_reply ON message(work_id, reply_to_seq, from_identifier);
CREATE INDEX IF NOT EXISTS idx_message_to_identifier ON message_to(identifier, message_id);
CREATE INDEX IF NOT EXISTS idx_participant_work ON participant(work_id, identifier);
`;

export function createDatabase(path = ":memory:") {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
  }
  database.exec(SCHEMA);

  const current = database.prepare("SELECT MAX(version) AS version FROM schema_meta").get().version;
  if (current === null) {
    database.prepare(
      "INSERT INTO schema_meta(version, migrated_at) VALUES (?, ?)",
    ).run(SCHEMA_VERSION, new Date().toISOString());
  } else if (current === 1) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(
        "ALTER TABLE work ADD COLUMN expected_participant_identifier TEXT",
      );
      database.exec(
        `ALTER TABLE work ADD COLUMN expected_participant_role TEXT
         CHECK (expected_participant_role IN ('owner','designer','implementer'))`,
      );
      database.prepare(
        "INSERT INTO schema_meta(version, migrated_at) VALUES (?, ?)",
      ).run(SCHEMA_VERSION, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      database.close();
      throw error;
    }
  } else if (current !== SCHEMA_VERSION) {
    database.close();
    throw new Error(
      `Unsupported database schema ${current}; server expects ${SCHEMA_VERSION}`,
    );
  }

  return database;
}

export function inTransaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getDatabasePragmas(database) {
  return {
    busy_timeout: database.prepare("PRAGMA busy_timeout").get().timeout,
    foreign_keys: database.prepare("PRAGMA foreign_keys").get().foreign_keys,
    journal_mode: database.prepare("PRAGMA journal_mode").get().journal_mode,
  };
}

export const databaseSchemaVersion = SCHEMA_VERSION;
