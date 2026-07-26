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
**Never silently reuse an occupied implementer slot**: `ao join` refuses it
without `--confirm-occupied`, and the helper passes that flag only after the
owner chose a visibly occupied room.

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
addressed to you before lower-priority work.

### 6. Register a periodic self-check — mandatory

Nothing will wake you. Register a repeating check now:

- **Codex app**: create a **カスタム スケジュール** (Scheduled tasks in the
  English manual) that runs `ao watch --once` every 2 minutes.
- **Claude Code**: run `watch-passive.mjs` under Monitor **and** keep calling
  `ao watch --once` yourself. Monitor alone does not refresh your heartbeat.
- **Any other or unknown runtime**: rely on the loop below alone; do not invent
  a feature name or procedure — ask the owner.

**Confirm it fired at least once before continuing.** If you cannot register it,
say so in step 7 and state how else you will check every 2 minutes. Silently
skipping this step is the most common way agents stop responding.

### 7. Post the startup report

```sh
node .agents/skills/session-chat/scripts/post-safe.mjs --type status \
  --body "worktree=<path> branch=<branch> identifier=<id> schedule=<registered|unavailable:<reason>> accepted=<what> first-unit=<what>"
```

Name your worktree path, branch, identifier, and whether step 6 succeeded.
This post is the proof that startup finished — post a `status` start message
before doing any work. Begin the self-driven loop below immediately afterwards,
starting with `ao watch --once`.

## Loop: repeat until the owner dismisses you

1. Do one bounded unit of work (one file, one test batch).
2. Run `ao watch --once`.
3. Read every line. If `your_ball` is true, keep working; do not wait.
4. Go to 1. Run `ao issues <PROJECT>` at startup and every few cycles — nothing
   raises an issue for you.

Run step 2 at least every 2 minutes during long work. If you must wait on
something external, post what you are waiting for, then keep looping. Never end
a turn with only "waiting".

Your heartbeat advances only when you run an active command.
A persistent `ao watch` delivers messages but does not update your heartbeat,
so it never replaces this loop. If your heartbeat stops while you hold the ball,
you are treated as abandoned and the owner is told.

### Assume you will be stopped, and make restarting cheap

**Your runtime may stop you at any time, with no warning and no scheduler.**
When that happens a human has to notice and restart you. Two rules make that
cheap:

1. **Do as much as you safely can in one turn.** Do not stop after one small
   step to ask something you could have determined yourself.
2. **Before your turn ends, post a `status` with a resume point.** Say what you
   finished, what is half-done and where, and the exact next unit. Whoever
   restarts you should not have to reconstruct your state.

```sh
node .agents/skills/session-chat/scripts/post-safe.mjs --type status \
  --body "done=<what> in-progress=<what, where> next=<exact next unit> blocked-by=<none|what>"
```

**A stall with a resume point costs one message. A stall without one costs a
reconstruction.**

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
- **Work outside the current scope becomes an issue, not a `question`.** File it
  with `ao issue-create` in the project that owns it, which may not be yours.
  Use a `question` only when someone must answer now.
  Issues send no notification and never create a ball, so read them yourself
  with `ao issues <PROJECT>`.
- **Pushing your own work branch is pre-authorized. Do not ask, and do not
  wait.** Commit and `git push` whenever you have something worth keeping —
  including work in progress. If a tool gate asks you to confirm sending code to
  the remote, this rule is your standing authorization; confirm it.
  Unpushed commits have already been lost in this project, and a pushed work
  branch changes nothing for anyone else.
- **Publishing still needs an explicit owner instruction.** Without one, never:
  open or merge a pull request; push to `main` or to any branch another checkout
  holds; deploy or restart a production service; delete anything that is not
  empty.
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
# Issues: backlog for later, in any project. No notification, no ball.
ao issues <PROJECT> [--state open|closed|all]
ao issue <PROJECT> <NUMBER>
ao issue-create <PROJECT> --title TITLE --body TEXT
ao issue-comment <PROJECT> <NUMBER> --body TEXT
ao issue-close <PROJECT> <NUMBER> --reason TEXT   # --reason is required
ao issue-reopen <PROJECT> <NUMBER>
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

**Declare a ball only when you need something from that participant.** A ball
makes them the one who must respond, so a stale heartbeat then reports them as
abandoned. Declaring a ball on a report that asks for nothing is how this
project generated repeated false abandonment notices.

Only the newest declaration counts, so **hand a ball back with `--ball ''`**
when the request is settled and nobody owes anything:

```sh
ao post --type status --ball '' --body "完了。誰の応答も待っていない"
```

## Resolution order — both directions matter

The server resolves as `AO_SERVER_URL`, then repository `.ao/config.json`, then
the user default in `~/.ao/config.json`.
**Only `AO_SERVER_URL` overrides a repository setting.** Writing a server into
`~/.ao/config.json` once sent this project's traffic to the wrong database.

Identity resolves the other way round, most specific first:
`--identifier` / `--role`, then `AO_IDENTIFIER` / `AO_ROLE`, then repository `.ao/config.json`.
**Do not write identity into `~/.ao/config.json`** — it is a
server default only. When multiple agents share one checkout, give each process
its own `AO_IDENTIFIER`; a shared repository config once recorded a designer's
posts as `implementer`, so answers never resolved their questions and the room
stayed permanently abandoned. Rationale:
`docs/adr/0010-identity-is-per-agent-not-per-repository.md`.

Set `AO_CLI` only to override the recorded CLI path; the environment variable
takes precedence, then `cli.command` in config, then `ao` on PATH.

If your config has `role=designer` and no `work`, you are project-scoped:
follow the `design-handoff` skill and use `ao watch --project --once`.
