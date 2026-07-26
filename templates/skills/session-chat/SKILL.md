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
4. Start `ao watch`; it polls every 10 seconds and prints one event per line.

Post with `ao post --type <type> --body <text>`. Add recipients with `--to`,
references with `--ref`, and document expectations with
`--expect <doc>=<revision>`. Answers require `--reply-to <seq>`. Use `--ball`
to declare non-question work ownership; unanswered questions are tracked by
the server and cannot be cleared by declarations.

Treat document expectations as advisory. A stale expectation means pull before
processing the message. Document writes use a base revision and can fail with
409; reapply the small edit to the refreshed copy and push again.

`resolve` records design/implementation agreement. It does not close the
thread, stop heartbeats, or permit an agent to leave. Continue watching until
the owner explicitly dismisses the participants.
