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
one participant answering does not discharge another recipient. Keep watching
after resolve because review findings and deployment failures can reopen work.
