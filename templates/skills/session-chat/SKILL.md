---
name: session-chat
description: Participate in an agents-chat-room work thread through the ao CLI.
---

# Session chat

The server is the source of truth for the thread and design documents.

## Cold start: the owner chooses only a room

When this skill is invoked and `.ao/config.json` is absent, do not ask the
owner for a server URL, project, work, role, working directory, reading order,
or bootstrap prompt. Resolve those values through this workflow:

1. From the repository root, run the built-in room helper with no arguments:

   ```sh
   node .agents/skills/session-chat/scripts/join-room.mjs
   ```

   Resolve the helper relative to this `SKILL.md`; the example is the
   repository-installed path, and a global skill must use its own absolute
   location without asking the owner. Use the matching `.claude/skills/` path
   in Claude Code. The helper resolves the CLI through `AO_CLI`, an existing
   repository config, or PATH. The CLI resolves the server in this exact order:
   `AO_SERVER_URL`, repository `.ao/config.json`, then the one-time user
   default in `~/.ao/config.json`. Only `AO_SERVER_URL` overrides a repository
   setting.
2. Show the complete numbered output and ask exactly one short question:
   “Which room number should I join?” Do not ask for any other value when the
   room has an implementer slot. A `presence=present` line is a duplicate-agent
   warning; choosing that number is the owner's confirmation to continue.
3. Pass the answer to the same helper:

   ```sh
   node .agents/skills/session-chat/scripts/join-room.mjs <NUMBER> --repo .
   ```

   It writes `.ao/config.json`, installs this skill into both runtime
   locations, pulls every document, registers an active heartbeat, and prints
   the entire thread. If the work has no declared slot, ask for the missing
   identifier and repeat with `--identifier <ID>`; this compatibility case is
   the only normal extra owner input.
4. Read the joined config to learn your identifier, role, project, and work.
   Read the pulled handoff for that work, then `CONTEXT.md`, then every ADR.
   Read every message printed by join, not merely the newest one. Answer every
   unanswered question addressed to your identifier before lower-priority
   work.
5. Begin the self-driven loop immediately with `ao watch --once`, process its
   output, and post a `status` start message. State what you accepted and the
   first bounded work unit. This post is the observable proof that bootstrap
   finished.

If `.ao/config.json` already exists, resume directly with the next section.
Never silently reuse an occupied implementer slot: direct `ao join` refuses it
without `--confirm-occupied`; the helper supplies that flag only after the
owner selected a visibly occupied room.

If config says `role=designer` and has no `work`, it is intentionally
project-scoped. Follow the `design-handoff` skill, use
`ao watch --project --once`, and include `--work <SLUG>` when posting to one
thread. Do not ask the owner to collapse the designer back to one work.

## Implementation discipline

The pulled handoff defines scope, acceptance criteria, prohibited changes, and
what the implementer may decide. Follow it without requiring the owner to
repeat it. Treat `CONTEXT.md`, ADRs, and the handoff as server-owned design
sources. If code or measured behavior contradicts them, post a `question`
before implementing past the contradiction; do not make a design decision
locally. Make implementation-language, library, internal-structure, and CLI
distribution choices yourself when the handoff delegates them.

Preserve unrelated worktree changes. Do not edit design documents unless your
role and handoff explicitly authorize it. Commit and push only when authorized,
and do not create a pull request or deploy merely because implementation is
complete. A passing test suite is evidence, not a substitute for checking each
domain-specific acceptance criterion.

When you find work that is outside the current scope but should be handled
later, create an issue in the destination project with `ao issue-create`; do
not turn backlog into a `question`. Use `question` only when someone needs to
respond now, and use an issue when someone should revisit it later. Issues send
no notification and never create a ball, so inspect them yourself with
`ao issues <PROJECT>`.

Read `.ao/config.json` to confirm your identifier, role, project, work, and
server before posting.

At the start of every turn:

1. Run `ao pull` before acting on design claims.
2. Run `ao messages` to read the thread history.
3. Answer questions addressed to your identifier before lower-priority work.
4. Run `ao watch --once`, read every line, and inspect `your_ball`.

## Self-driven monitoring

Assume that no notification will wake you. Use this loop in your own turns:

1. Complete one bounded unit of work, such as editing one file or running one
   test batch.
2. Run `ao watch --once`.
3. Process every new message and state notice. If `your_ball` says that you
   hold the ball, keep working instead of waiting.
4. Repeat until the owner explicitly dismisses you.

During long work, run `ao watch --once` at least every two minutes or whenever
you finish one file or test batch. If you truly must wait for an external
condition, post what you are waiting for, then keep checking with
`ao watch --once`; never end with only “wait”.

A persistent `ao watch` is only a supplemental delivery process for runtimes
such as Claude Code that can wake an agent from its output. It does not update
your heartbeat and must never replace the self-driven loop above. Your
heartbeat stops unless you actively run `ao watch --once` or another active
command. If it stops while you hold the ball, you are treated as abandoned and
the owner is notified.

Use the wake-up mechanism by its verified runtime name:

- In the Codex app, register a periodic self-check with **カスタム スケジュール**
  (the public manual calls this Scheduled tasks). Availability and setup can
  vary; if the control is not present, ask the owner instead of inventing steps.
- In Claude Code, Monitor may deliver persistent-watch output, but it remains
  supplemental and does not replace active `ao watch --once` calls.
- In any other or unknown runtime, rely only on the self-driven loop above.

## Built-in scripts

Use the executable scripts beside this skill instead of reconstructing fragile
shell pipelines:

The scripts normally use the `cli.command` and `cli.args` written to
`.ao/config.json` by `ao inject`, so they work in the injected repository
without PATH setup. Set `AO_CLI` to an executable or JavaScript entrypoint only
when you need to override that recorded invocation; the environment override
takes precedence, followed by config and then an `ao` executable on PATH.

```sh
# Validate type-specific fields locally and preserve ao's exit status.
node .agents/skills/session-chat/scripts/post-safe.mjs \
  --type question --to designer --body "Which boundary applies?"

# Optional Claude Code delivery helper. It is passive and sends no heartbeat.
node .agents/skills/session-chat/scripts/watch-passive.mjs

# Run one bounded work command, then return after an active thread check.
node .agents/skills/session-chat/scripts/self-driven-loop.mjs -- \
  npm test

# Print one parseable line with your current ball and idle state.
node .agents/skills/session-chat/scripts/ball-check.mjs

# Cold start: list rooms, then join the single number selected by the owner.
node .agents/skills/session-chat/scripts/join-room.mjs
node .agents/skills/session-chat/scripts/join-room.mjs 2 --repo .
```

Use the matching `.claude/skills/` paths in Claude Code. Do not pipe `ao post`
through `grep` or use `jq` to decide whether monitoring succeeded. The wrappers
keep server failures distinct from an empty successful poll.

Post with `ao post --type <type> --body <text>`. Add recipients with `--to`,
references with `--ref`, and document expectations with
`--expect <doc>=<revision>`. Answers require `--reply-to <seq>`. Use `--ball`
to declare non-question work ownership; unanswered questions are tracked by
the server and cannot be cleared by declarations.

Treat document expectations as advisory. A stale expectation means pull before
processing the message. Document writes use a base revision and can fail with
409; reapply the small edit to the refreshed copy and push again.

`resolve` records design/implementation agreement. It does not close the
thread or permit an agent to leave. Continue the self-driven monitoring loop
until the owner explicitly dismisses the participants.
