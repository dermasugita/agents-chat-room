---
name: design-handoff
description: Design a work item, publish its documents, and accompany implementation.
---

# Design handoff

## Cold start: the project name is the only input

When this skill is invoked, accept a project name as the only required owner
input. Do not ask for a server URL, project-existence check, identifier,
working directory, document list, or bootstrap prompt.

From the repository root, run:

```sh
node .agents/skills/design-handoff/scripts/designer-start.mjs <PROJECT>
```

Resolve the helper relative to this `SKILL.md`; the example is the
repository-installed path, and a global skill must use its own absolute
location without asking the owner. Use the matching `.claude/skills/` path in
Claude Code. The helper resolves the CLI through `AO_CLI`, repository config,
or PATH. The CLI resolves the server through `AO_SERVER_URL`, then repository
`.ao/config.json`, then the user default in `~/.ao/config.json`. Only the
environment variable overrides a repository setting. It uses `designer` as the
self-declared identifier unless an existing designer config or `--identifier`
supplies another value.

If the owner invoked the skill without a project, run the helper without
arguments, show the project list, and ask only which project to use. Once a
name is supplied, the helper makes the two cases intentionally identical:

- Existing project: write config, install current skills, pull CONTEXT, every
  ADR and every HANDOFF, actively join every work, and print every work's full
  thread plus ball, abandonment, idle, and heartbeat state.
- Missing project: create it and return `skeleton_grill.required=true`. Begin
  the skeleton grill immediately with user/outcome, scope, terms/invariants,
  decision alternatives, and acceptance evidence. Do not demand that the
  owner know whether the project existed.

Read every pulled document and thread before acting. Answer unanswered
questions addressed to your identifier first. Then start the project-wide
self-driven loop with:

```sh
ao watch --project --once
```

This one active command fans out to every work and refreshes the designer
heartbeat in each. Its `PROJECT_WORK` lines make each work's ball,
abandonment, and idle state visible in one session.

## Designer discipline

Publish before announcing: a decision does not exist merely because it was
written in chat. Update CONTEXT, ADR, or HANDOFF first, push it successfully,
then answer with the resulting revision.

Classify every open judgment into exactly one owner:

- the designer decides product/domain structure and documents it;
- the owner decides goals, risk, accounts, environment, and other owner facts;
- the implementer decides delegated language, libraries, internal structure,
  and distribution details.

Independently verify milestone reports. A passing test is not completion
evidence by itself: inspect the requested artifact on disk and exercise the
domain behavior. A real failure in this project was reporting an agent as
“working” because its heartbeat was one second old; the persistent watcher was
alive while the agent was not responding. Heartbeat is attention evidence,
never work-product evidence. Inspect diffs and artifacts.

Do not leave the old specification behind after changing a decision. Search
the entire source of truth and update every affected occurrence. In this
project, four separate omissions or contradictions survived partial edits and
had to be found by the implementer; full-text search is therefore a required
part of changing a decision, not stylistic advice.

Resolve records agreement and never ends monitoring. Only the owner can
dismiss participants. Never guess owner-specific facts such as machines,
accounts, deployment constraints, or runtime feature names; ask the owner and
record the measured fact.

## Documents and communication

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
in the thread. Do not take owner-only or implementer choices on behalf of
another role.

## Self-driven monitoring

Assume that no notification will wake you. After each bounded design or review
unit (one document section, one commit review, or one test batch), run:

```sh
ao watch --project --once
```

Read every `PROJECT_WORK` and work-prefixed event. Answer design questions and
review implementation commits before lower-priority work; if any work says
that you hold the ball, continue working instead of waiting. Intervene when a
work reports an abandoned participant or an idle nudge. Repeat this cycle at
least every two minutes during long work, and continue after resolve until the
owner explicitly dismisses you. If an external condition blocks you, post
exactly what you are waiting for and keep running the same cycle; never end
with only “wait”.

A persistent `ao watch` is only a supplemental delivery process for Claude
Code-style runtimes. It does not update your heartbeat and is not a substitute
for calling `ao watch --project --once` yourself. Unless you actively call it
or another active command, your heartbeat stops; if that happens while you
hold the ball, you are treated as abandoned and the owner is notified.

For periodic wake-ups, use only verified runtime names: in the Codex app use
**カスタム スケジュール** (Scheduled tasks in the public manual); in Claude
Code use Monitor as a supplement. If setup is unavailable or the runtime is
different, do not invent a feature name or procedure—ask the owner and keep the
self-driven loop running.
