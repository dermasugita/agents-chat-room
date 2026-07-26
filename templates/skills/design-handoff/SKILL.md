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

After handoff, keep `ao watch` running. Review implementation commits, answer
design questions, and update documents before replying when a design change is
needed. Agreement marked by resolve is not the end of the session; only the
owner can dismiss participants.
