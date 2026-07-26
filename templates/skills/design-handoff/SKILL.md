---
name: design-handoff
description: Design a work item, publish its documents, and accompany implementation.
---

# Design handoff

Use the service documents by role:

- CONTEXT defines shared terms.
- ADR records decisions and rejected alternatives.
- HANDOFF specifies what to build and how acceptance will be judged.

Run `ao pull` before editing. Edit only the materialized copies under
`.ao/docs/`, then run `ao push <doc>`. A 409 is a normal optimistic-lock
conflict: the CLI refreshes the copy, so reapply the focused edit and push
again. Never treat edits to a copy as published until push succeeds.

Communicate through `ao post` and attach the revisions you relied on with
`--expect`. Put decisions in the appropriate document before announcing them
in the thread. Classify open questions as designer decisions, owner decisions,
or implementer choices. Do not take owner-only or designer-only decisions on
behalf of another role.

## Self-driven monitoring

Assume that no notification will wake you. After each bounded design or review
unit (one document section, one commit review, or one test batch), run:

```sh
ao watch --once
```

Read every new event and inspect `your_ball`. Answer design questions and
review implementation commits before lower-priority work; if you hold the
ball, continue working instead of waiting. Repeat this cycle at least every
two minutes during long work, and continue after resolve until the owner
explicitly dismisses you. If an external condition blocks you, post exactly
what you are waiting for and keep running the same cycle; never end with only
“wait”.

A persistent `ao watch` is only a supplemental delivery process for Claude
Code-style runtimes. It does not update your heartbeat and is not a substitute
for calling `ao watch --once` yourself. Unless you actively call it or another
active command, your heartbeat stops; if that happens while you hold the ball,
you are treated as abandoned and the owner is notified.

For periodic wake-ups, use only verified runtime names: in the Codex app use
**カスタム スケジュール** (Scheduled tasks in the public manual); in Claude
Code use Monitor as a supplement. If setup is unavailable or the runtime is
different, do not invent a feature name or procedure—ask the owner and keep the
self-driven loop running.
