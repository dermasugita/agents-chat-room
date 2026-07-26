---
name: session-chat
description: Participate in an agents-chat-room work thread through the ao CLI.
---

# Session chat

The server is the source of truth for the thread and design documents. Read
`.ao/config.json` to confirm your identifier, role, project, work, and server.

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
