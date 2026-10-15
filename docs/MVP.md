# Fix factory — MVP, later features, live updates

`WORKFLOW.md` is the target. This file is the first thing to build.

## MVP scope

Investigation and fixing stay close to today: an Opus agent per failure, in its own worktree, following
`debug-a-test-failure` and running `mach` itself. The MVP replaces the expensive *parent* work: status, review
comments, rebases, stack reorganisation and submission. Today that's the $166–$265 parent and "integrator" threads.

### How the stack is produced (MVP)

1. Each investigation agent (**Opus**, as today) commits its fix in its own worktree. It writes the commit message
   with the commit-message skill, records any patch it must land after, and writes a proposed try command to
   `artifacts/try-request.sh`.
2. **Script** `lint-text.ts --kind commit` checks the message. On failure, the author gets the violations back.
3. **Script** `stack.ts assemble` cherry-picks every finished commit onto the request's stack branch, in the
   order computed by **script** `stack.ts order`: each patch after its declared deps, otherwise the order the fixes
   finished. You can drag rows in the UI to change it. A conflict goes to **Sonnet** (`resolve-conflict.md`). If
   Sonnet reports it as semantic, it goes back to the author.
4. **Try:** **script** `try.ts merge` unions the agents' try requests mechanically: all `-q` queries, all paths, the
   highest `--rebuild`, and `--no-artifact` if any request had it. It dry-runs the result and shows the task list.
   **You** approve, then **script** `try.ts push` and `try.ts watch` take over.
5. **Submit:** **script** `stack.ts check`, then **you** click `moz-phab submit`.
6. **Reorg for landing / rebase:** **script** `stack.ts order --landable` + `stack.ts rewrite` (rebase onto
   central included). Conflicts → **Sonnet**, flipped soft deps → **Haiku/Sonnet** (`adapt-soft-dep.md`), semantic →
   the author (**Opus**). **Script** lists the revisions whose diff changed, and **you** click `moz-phab submit`.

### Who does what (MVP)

| Step | Script | Haiku | Sonnet | Opus | You |
|---|---|---|---|---|---|
| Investigate, fix, commit message | | | | author, as today | |
| Worktree create/remove | `worktree.ts` | | | | |
| Commit message check | `lint-text.ts` | | | | |
| Assemble / order / rewrite / rebase the stack | `stack.ts` | | conflicts | semantic conflicts | change the order |
| Soft dep flipped by a reorder | | trivial | otherwise | | |
| Merge try requests, push, watch, results table | `try.ts`, `failures.ts` | | | | approve the push |
| Route try failures | `failures.ts try-table` sends each failing test to the agent whose patch touches that test or its folder | | | author reads its failures | failures matching no patch |
| Pre-submit checks | `stack.ts check` | | | | |
| Submit / resubmit | `phab.ts run-moz-phab` | | | | click |
| Poll reviews | `phab.ts poll` | | | | |
| Classify comments | | `classify-review-comments.md` | | | |
| Apply suggested edits | `stack.ts rewrite` | | | | |
| Address change requests | | | | author (resumed) | |
| Interdiff | `stack.ts interdiff` | | | | |
| Draft replies | `lint-text.ts` checks | | `draft-reply.md` | | copy, post |
| "Bug to file" link, find the filed bug | `bugzilla.ts` | | | | file it |
| Status page, profiles | `server.ts` | | | | |
| "Tell the factory…" | | | | `recover.md` | approve the plan |

### Milestones (each one usable on its own)

- **M1, status, read-only:**
  - `stack.ts import` adopts the stacks already in flight;
  - `phab.ts poll`, `try.ts watch`, `failures.ts try-table`;
  - each agent's state from its `sessionlog.md` state line;
  - the web UI with profile links.

  No agents.
- **M2, review round-trip:** classify, suggested edits, address, interdiff, replies, resubmit, stack-viewer comments → author.
- **M3, stack operations:** assemble, deps, order, rewrite, rebase, conflicts, `stack.ts check`.
- **M4, starting work from the UI:**
  - worktree + investigation agent (`investigate-and-fix.md`);
  - try merge/approve/push;
  - "Bug to file";
  - "Tell the factory…";
  - concurrency caps (N agents, M builds);
  - cost recording in `agent-run.ts`.

### Later (rough order)

1. Request profile with a marker for every step.
2. Feedback field + per-target files.
3. Health checks that pause dependent jobs.
4. Patch review (`review-patch.md` + skill) and stack review run automatically.
5. Effort/value ordering and the meta-bug summary.
6. Scheduler with a cores/RAM model and measured peaks.
7. Scripted evidence: `artifacts.ts`, `run-tests.ts`. Agents stop running `mach` and return requests instead.
8. Investigation split from fixing (handoff → Sonnet `implement-fix.md`), plus repro recipes and `--compare` verification.
9. `try.ts select` + `review-try-selection.md`, one push per folder.
10. Burndown intake (`annotations.ts`, un-skip push, clustering, prior art).

## Updating the factory without stopping it

Work runs for days, so **every process can be restarted on its own without losing anything**.

**Separate processes, sharing only SQLite (WAL mode) and files:**
- `server.ts` (web UI) reads the DB and writes your clicks to a `commands` table. It holds no state.
  Restart it whenever you like; the page reconnects its SSE stream on its own.
- `orchestrator.ts` reads `commands` and job results, and starts jobs. It holds no state that isn't in the DB.
- **Jobs (agents, builds, test runs, try watchers) are detached processes** (`spawn` with `detached`, own process
  group). Their output goes to a file, and a small wrapper writes the exit code to a file when they end. Restarting
  the orchestrator doesn't touch them.
- When the orchestrator starts, it reconciles. For each running job it checks the pid and its start time (pid reuse),
  re-attaches to the output file, and collects the results of jobs that ended while it was down.
- **CLIs and prompts are read fresh on every invocation.** A new version applies to the next job; running jobs finish
  on the old one. Every job records the code version and prompt version it ran with.

**What couples them:**
- **The DB schema** (one `schema.ts` shared by all of them). Migrations are additive only: new tables, new nullable
  columns. The orchestrator runs them at startup. A destructive change needs a planned stop.
- **CLI JSON output:** add fields, don't rename them.

**Deploying:**
- The factory runs from `releases/<sha>/` behind a `current` symlink.
- A deploy is: check out the new sha into its own directory, run the tests, swap the symlink atomically, then
  restart the server and orchestrator (a few seconds each).
- A job resolves the symlink when it's started, so it never sees a half-updated tree.
- Rollback = swap the symlink back.
- To try a change before deploying, run a second instance on a copy of the DB with `--dry-run`. It refuses
  every external side effect: try pushes, Phabricator, Bugzilla, starting agents.

So yes: the CLIs don't depend on each other, and the web UI doesn't depend on the orchestrator. Their only contract
is the DB schema.
