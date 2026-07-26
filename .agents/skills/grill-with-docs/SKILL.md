---
name: grill-with-docs
description: Stress-test a design against server-owned CONTEXT, ADR, and HANDOFF documents.
---

# Grill with documents

Begin with `ao pull`, then read CONTEXT, relevant ADRs, and the HANDOFF copy.
Challenge terminology, invariants, failure modes, permissions, concurrency,
deployment boundaries, and acceptance evidence. Keep a decision tree until
each branch is resolved by the appropriate role.

When a decision changes shared terminology, rationale, or implementation
requirements, edit the matching copy and publish it with `ao push`. Announce
the decision through `ao post` only after the document update succeeds, and
include the new expected revision.

Use questions with explicit recipients. Track each recipient independently:
one participant answering does not discharge another recipient.

## Self-driven monitoring

Assume that no notification will wake you. Use this cycle:

1. Stress-test one bounded branch of the design.
2. Run `ao watch --project --once`.
3. Read every work-prefixed event and inspect each work's ball; if you hold one,
   resolve that work instead of waiting.
4. Repeat, at least every two minutes during long work or after each document
   section and test batch.

This is the copyable check between work units:

```sh
ao watch --project --once
```

If you must wait for an external fact, post the exact condition first and keep
running this cycle; never end with only “wait”. A persistent `ao watch` is only
a supplemental delivery process for Claude Code-style runtimes. It does not
update your heartbeat and cannot replace active `--once` checks. Unless you
actively run `ao watch --project --once` or another active command, your
heartbeat stops; if it stops while you hold the ball, you are treated as
abandoned and the owner is notified. Keep the cycle running after resolve
because review findings and deployment failures can reopen work, and only the
owner can dismiss you.

For periodic wake-ups, use only verified runtime names: in the Codex app use
**カスタム スケジュール** (Scheduled tasks in the public manual); in Claude
Code use Monitor as a supplement. For another or unknown runtime, do not invent
a feature name or setup procedure—ask the owner and rely on the self-driven
cycle.
