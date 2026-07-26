# agents-chat-room

A passive coordination service for design–implementation work. The server
keeps design documents, revision history, work threads, participant heartbeats,
and ball state in SQLite. Agents use the `ao` CLI; the owner uses the web
endpoint.

The service does not launch or orchestrate agent processes. Code remains in
GitHub. The database is the source of truth only for CONTEXT, ADR, HANDOFF, and
thread messages.

## Requirements

- Docker 29+ on the deployment host (`linux/amd64`)
- Node.js 22.14 or newer wherever the pure-JavaScript CLI runs
- SSH access to the deployment host for local port forwarding

The server uses the built-in `node:sqlite` module. Node 22 reports an
`ExperimentalWarning`; this is expected. It avoids native addons, compiler
toolchains, and architecture-specific CLI packages.

## Deploy the server

Build and start the single x86_64 image with the deployment script:

```sh
node scripts/deploy.mjs \
  --image agents-chat-room:0.1.0 \
  --name agents-chat-room \
  --port 7331 \
  --volume agents-chat-room-data
curl --fail http://127.0.0.1:7331/health
```

Use `--dry-run` to inspect the exact Docker argument arrays without changing
state. The script always constructs the host publication as
`127.0.0.1:<port>:7331`; it has no option that can omit the host IP.

The equivalent generated commands are:

```sh
docker build --platform linux/amd64 -t agents-chat-room:0.1.0 .
docker volume create agents-chat-room-data
docker run --detach \
  --name agents-chat-room \
  --restart unless-stopped \
  --platform linux/amd64 \
  --publish 127.0.0.1:7331:7331 \
  --volume agents-chat-room-data:/data \
  agents-chat-room:0.1.0
curl --fail http://127.0.0.1:7331/health
```

Or use the included Compose file:

```sh
docker compose up --detach --build
curl --fail http://127.0.0.1:7331/health
```

The container process must listen on its internal interfaces so Docker can
forward traffic to it. The security boundary is the host-side publish, which is
fixed to `127.0.0.1` in every shipped command and in `compose.yaml`. The API and
web endpoint are unauthenticated; never remove the host IP from the publish
mapping.

The named volume `agents-chat-room-data` contains `/data/ao.sqlite` and its WAL
files. Back up that volume as the service source of truth.

## Back up the database

Use the SQLite `VACUUM INTO` wrapper while the server is running. It creates a
consistent snapshot that includes committed data still resident in the WAL,
then opens the result and prints the row count of every application table:

```sh
volume_path=$(docker volume inspect \
  --format '{{.Mountpoint}}' agents-chat-room-data)
sudo node scripts/backup-db.mjs \
  "$volume_path/ao.sqlite" \
  "./backups/ao-$(date +%Y%m%d-%H%M%S).sqlite"
```

The command refuses to overwrite an existing destination and exits nonzero if
the resulting database has no domain rows beyond schema metadata. Keep the
printed table-count report with the backup log.

## Connect over SSH

Keep the server private on the host and open a local tunnel:

```sh
ssh -N -L 127.0.0.1:7331:127.0.0.1:7331 i-sugita
```

In another terminal:

```sh
curl --fail http://127.0.0.1:7331/health
```

## Install the CLI

The package has no runtime dependencies or native addons. Build a tarball on
either supported machine:

```sh
npm pack
npm install --global ./agents-chat-room-0.1.0.tgz
ao --help
```

Copy the same tarball to the other machine and install it with its Node 22.14+
runtime.

## Start a project

Create or reuse a server project and inject the service workflow into a target
repository:

```sh
ao inject /path/to/repository \
  --server http://127.0.0.1:7331 \
  --project example \
  --identifier designer-a \
  --role designer \
  --work implementation \
  --work-title "Implementation"
```

Injection creates `.ao/config.json`, materialized document copies under
`.ao/docs/`, and service workflow skills under both `.claude/skills/` and
`.agents/skills/`. It appends marked pointers to `CLAUDE.md` and `AGENTS.md`
without replacing existing content. Changed skill files are backed up before
replacement. `/.ao/` is added to `.gitignore`. When `--work` is present,
injection also creates that work or reuses it if it already exists. The work
title defaults to its slug when `--work-title` is omitted.

The injected `session-chat` skill includes executable, dependency-free Node
scripts for validated posting, passive delivery monitoring, one self-driven
work/check cycle, and one-line ball inspection under
`.agents/skills/session-chat/scripts/` and the matching `.claude/` path.
Injection records the current Node command and CLI entrypoint in
`.ao/config.json`, so those scripts work without a global `ao` on PATH.
`AO_CLI` can explicitly override the recorded invocation.

Create additional works and documents:

```sh
ao create-work implementation --title "Implementation"
ao create-document context --title "Shared terms" --file CONTEXT.md
ao create-document handoff --slug implementation --title "Implementation handoff" \
  --file docs/handoff/implementation.md
```

Use the thread:

```sh
ao post --work implementation --type question --to implementer \
  --body "Please verify the deployment boundary."
ao messages --work implementation
ao watch --work implementation
```

`ao watch` polls every 10 seconds. New messages, idle nudges, abandonment
warnings, stale document expectations, and ball state are each printed as one
line. A persistent watch is delivery-only and does not refresh the
participant's heartbeat: a background process must not make an absent agent
look attentive.

Agents must actively run `ao watch --once` at least every two minutes or after
each bounded edit or test batch, process the result, and then continue work.
`--once`, `post`, `pull`, `push`, `messages`, `close`, and `resolve` refresh the
attention heartbeat. If heartbeat stops while the participant holds the ball,
other participants see it as abandoned after three minutes.

CLI exit codes are stable so commands can be safely chained:

| Code | Meaning |
|---|---|
| `0` | The command completed successfully |
| `1` | A request was invalid, the server was unreachable, or another non-conflict error occurred |
| `2` | Operator action is required: revision conflict, protected pull, or unconfirmed import |

## Documents

Pull server documents into `.ao/docs/`:

```sh
ao pull
```

Edit a copy, then push it explicitly:

```sh
ao push context --note "Define source of truth"
```

`ao pull` refuses to overwrite an unpushed edit unless `--force` is supplied.
On a 409 revision conflict, `ao push` refreshes the materialized copy, saves the
rejected body beside it with a `.rejected` suffix, and exits nonzero. Reapply
the focused edit to the refreshed copy and push again.

## Import a file-based repository

The CLI displays document, work, session, and message counts before importing.
Review the plan, then confirm explicitly:

```sh
ao import /path/to/legacy-repository --project legacy
ao import /path/to/legacy-repository --project legacy --yes
```

Original ADR numbers are retained. Session sequence numbers are assigned from
file order. Every source ID is retained as an `imported-id:` reference.
Ambiguous reply targets are set to null and retained as
`unresolved-reply-to:` references.

## Local development

Direct startup is safe by default and listens only on loopback:

```sh
npm start
```

Configuration:

| Variable | Default | Purpose |
|---|---|---|
| `AO_BIND` | `127.0.0.1` | Direct server bind. The image alone sets `0.0.0.0` internally. |
| `AO_PORT` | `7331` | HTTP port |
| `AO_DATABASE_PATH` | `./data/ao.sqlite` | SQLite file |
| `AO_SERVER_URL` | from `.ao/config.json` | CLI server override |

Run the complete acceptance suite:

```sh
npm test
```

The suite covers optimistic document locking, concurrent sequence allocation,
idempotency, per-recipient question balls, abandonment, resolve behavior,
idle nudges, materialized-copy safety, legacy import, injection, web owner
actions, and the runtime-neutral service skills.
