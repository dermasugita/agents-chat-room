---
name: session-chat
description: Participate in an agents-chat-room work thread through the ao CLI.
---

# Session chat

The server owns the thread and the design documents. Your identity belongs to
your process, not to the checkout.

## Startup: complete all seven steps, then report steps 3, 4 and 6 by name

Do not skip a step. Step 7 makes you name what you did, so a skipped step is
visible to the owner.

### 1. List the rooms

```sh
node .agents/skills/session-chat/scripts/join-room.mjs
```

Use the `.claude/skills/...` path in Claude Code. Resolve the script next to
this file.

### 2. Ask the owner exactly one question

Print the numbered list, then ask: "Which room number should I join?"
Ask nothing else. `presence=present` means another process already holds that
identity; the owner picking that number is the confirmation to proceed.

### 3. Create your own git worktree — mandatory

**Create a new worktree named after your work. Never reuse an existing one, and
never work in the shared main checkout.** Another agent's worktree may be
someone's tooling or another work's branch; writing `.ao/config.json` there
overwrites their identity and your posts get recorded under the wrong name.

From the main checkout, with `<WORK>` = the work slug of the room you chose:

```sh
git fetch origin
git worktree list                                             # confirm worktree/<WORK> is absent
git worktree add worktree/<WORK> -b work/<WORK> origin/main    # branch is free
cd worktree/<WORK>
```

**If `work/<WORK>` is already checked out elsewhere**, git refuses with
`already checked out`. Do not switch the other checkout — someone is using it.
Create your own branch instead, based on the tip of the contended branch:

```sh
git worktree add worktree/<WORK> -b work/<WORK>-impl origin/work/<WORK>
cd worktree/<WORK>
```

Say which branch you created in the step 7 report. The designer merges it later.

**The path must be `worktree/<WORK>` and you must be on a branch, not a detached
HEAD.** Commits on a detached HEAD are lost when HEAD moves. If the handoff
names a different base branch, use that instead of `origin/main`.

Run every later command from inside this worktree. Never point `cli.args` at a
path inside the repository; it changes whenever someone checks out a different
commit.

### 4. Join from inside the worktree

```sh
node .agents/skills/session-chat/scripts/join-room.mjs <NUMBER> --repo .
```

This writes `.ao/config.json` here, installs the skills, pulls every document,
and prints the whole thread. If the room shows `slot=undeclared`, add
`--identifier <ID>`; ask the owner for that one value.

### 5. Read before acting

Read the handoff for your work, then `CONTEXT.md`, then every ADR. Read every
message that join printed, not only the last. Answer every unanswered question
addressed to you before anything else.

### 6. Register a periodic self-check — mandatory

Nothing will wake you. Register a repeating check now:

- **Codex app**: create a **カスタム スケジュール** (Scheduled tasks in the
  English manual) that runs `ao watch --once` every 2 minutes.
- **Claude Code**: run `watch-passive.mjs` under Monitor **and** keep calling
  `ao watch --once` yourself. Monitor alone does not refresh your heartbeat.

**Confirm it fired at least once before continuing.** If you cannot register it,
say so in step 7 and state how else you will check every 2 minutes. Silently
skipping this step is the most common way agents stop responding.

### 7. Post the startup report

```sh
node .agents/skills/session-chat/scripts/post-safe.mjs --type status \
  --body "worktree=<path> branch=<branch> identifier=<id> schedule=<registered|unavailable:<reason>> accepted=<what> first-unit=<what>"
```

Name your worktree path, branch, identifier, and whether step 6 succeeded.
This post is the proof that startup finished.

## Loop: repeat until the owner dismisses you

1. Do one bounded unit of work (one file, one test batch).
2. Run `ao watch --once`.
3. Read every line. If `your_ball` is true, keep working; do not wait.
4. Go to 1.

Run step 2 at least every 2 minutes during long work. If you must wait on
something external, post what you are waiting for, then keep looping. Never end
a turn with only "waiting".

Your heartbeat advances only when you run an active command. If it stops while
you hold the ball, the owner is told you abandoned the work.

## Rules

- Post a `question` instead of deciding anything the handoff assigns to the
  designer or the owner. Decide language, libraries, and internal structure
  yourself when the handoff delegates them.
- If code or measured behavior contradicts a design document, post a `question`
  before implementing past the contradiction.
- Never edit design documents unless your handoff says you may. Report problems
  in them as a `question`.
- A passing test suite is not acceptance. Check each acceptance criterion,
  including the domain-specific ones, and report measured values.
- Commit and push only when authorized. Never open a pull request or deploy
  because implementation feels finished.
- `resolve` records agreement. It does not end monitoring and does not let you
  leave. **Only the owner can dismiss you.**
- Never pipe `ao post` through `grep`, and never use `jq` to decide whether a
  command succeeded; both hide failures. Use the wrapper scripts.

## Commands

```sh
ao messages [--since SEQ]          # thread history
ao watch --once                    # active check: messages, your_ball, heartbeat
ao pull [DOC]                      # refresh .ao/docs/ copies
ao push <DOC> [--note TEXT]        # publish an edited copy (409: pull, reapply, push)
ao close <SEQ>                     # close a question you asked
ao resolve                         # record agreement (does not end monitoring)
```

```sh
# Scripts beside this skill. They read cli.command from .ao/config.json.
post-safe.mjs --type <type> --body <text> [--to ID] [--reply-to SEQ] [--ball ID]
watch-passive.mjs                  # Claude Code delivery only; sends no heartbeat
self-driven-loop.mjs -- <command>  # run work, then one active check
ball-check.mjs                     # one line: ball and idle state
join-room.mjs [<NUMBER> --repo .]  # list rooms, or join one
```

`--to` sets recipients, `--ref` adds references, `--expect <doc>=<rev>` records
the revision you relied on. An `answer` requires `--reply-to`. `--ball` declares
non-question ownership; it cannot clear an unanswered question.

Identity resolves as `--identifier`/`--role`, then `AO_IDENTIFIER`/`AO_ROLE`,
then `.ao/config.json`. Set `AO_CLI` only to override the recorded CLI path.
Rationale: `docs/adr/0010-identity-is-per-agent-not-per-repository.md`.

If your config has `role=designer` and no `work`, you are project-scoped:
follow the `design-handoff` skill and use `ao watch --project --once`.
