# Orchestrator

`node src/orchestrator/main.ts`: one long-running process. It decides what happens next. Jobs do the work.
It holds no state of its own: everything it knows comes from `events.jsonl`, `commands.jsonl` and the job
files (see `CONTRACTS.md`), so it can be restarted at any time.

## Loop

A tick runs when `commands.jsonl` or a job's `exit.json`/`out.log` changes, and at least every 30 s:

1. **Commands:** execute the new ones in order (table below). Each records `command-executed` with the command id.
2. **Finished jobs:** parse the output of each job that ended (`exit.json`), and append `job-finished` plus the
   events its handler derives (tables below). Long jobs that print JSON lines (`try.ts watch`) are also read
   incrementally while they run.
3. **Next actions:** for each request, `next(state, now)` returns what to start and what to append. It is a pure
   function, and most of the tests are on it. The orchestrator then starts the jobs, within the caps.
4. **Timers:** `phab.ts poll` every 10 min for submitted patches. While a submit is waiting for you,
   `stack.ts import` runs every 2 min to pick up the new `Differential Revision:` trailers.

**Startup:**
- Fold every request.
- `reconcile` the running jobs. An **orphaned** job is cancelled and its step starts again. A **lost** job (no
  process, no `exit.json`) counts as a failure.
- Then start the loop.

**Caps and priority:**
- At most `maxAgents` agents and `maxBuilds` builds run at once.
- When more is ready than the caps allow, the order is:
  1. addressing review comments;
  2. anything you're waiting on (a recovery reply, a revised bug draft);
  3. the items furthest along;
  4. new items.

## Jobs and failures

- **Job id:** `<request>.<item or "req">.<name>.<n>`. Every job's working directory is a worktree or the request's
  directory in `stateDir`. It is never the worktree a `worktree.ts remove` deletes.
- **Script failure** (exit ≠ 0): retried once. If it fails again, the item or request becomes `blocked`, and a
  needs-user `failed:<job>` shows the error. From there, "Tell the factory…" is the way out.
- **Agent run:**
  - The prompt goes to `jobs/<id>/prompt.md` and is passed on stdin. The model comes from `prompts/index.json`.
  - The report must validate against `schemas/<prompt>.json`. If it doesn't, the session is resumed once with the
    validation errors. If it still doesn't, it's a failure as above.
  - Each `feedback` entry is appended to `feedback/<target>.md`.
  - The run's cost is the session's `total_cost_usd` minus what the session's earlier runs cost.
- **Resuming an author:** the same session (`--resume`), so the author keeps its context. If the session can't be
  resumed, a fresh `investigate-and-fix` session gets the author's last report and its commits in the message.

## Pipeline

S = script, H/So/O = agent (prompt name). `→` is what gets appended. Patch ids are `<item>.<n>`.

**1. Request.** Command `new-request` → `request-created`. Then So `parse-request` → `config-set`. This is shown
on the page but isn't a gate: corrections go through "Tell the factory…".
- Next step: `first signal` for a burndown, `work list` for a try push.

**2. First signal (burndown).**
1. S `annotations.ts list <folder>` → stored in a file.
2. H `classify-annotation`, once per annotation (cheap, capped like other agents).
3. S `worktree.ts create <request>-base --base <baseRef> --build artifact`.
4. So `write-annotation-patches` in that worktree → its 2 commits as patches.
5. O `review-patch` on the run-if commit. Findings → the writer is resumed, then re-reviewed (3 rounds max, then
   needs-user).
6. So `plan-try-pushes` (goal: reproduce). Inputs:
   - `failures.ts collect <folder>`, for the rates;
   - the DEBUG commit.
7. Each planned push: S `try.ts dry-run` → `try-planned` (with task count) + needs-user `approve-push:<push>`.
8. Command `approve-push` → S `try.ts push`, which gives `try-pushed`. Then S `try.ts watch` (a long job):
   - `progress` lines → `try-progress`;
   - `job-failed` lines → `try-job-failed`, plus S `artifacts.ts fetch` for that task;
   - the `finished` line → `try-finished`.

**3. Work list.** It runs at the first of these:
- the push finishes;
- 2 h after it started, so slow pools don't hold everything up. It then runs again when the push finishes: new
  groups are added, existing groups keep their items.

For a try-push request it runs on the given revision right away. Steps:
1. S `failures.ts try-table <rev>` → table file.
2. H `triage-try` on the unparsed jobs → notes. A job classified as infra shows on the page.
3. S `failures.ts cluster`, then H `merge-clusters` → one `item-created` per group.
4. Per item:
   - S `bugzilla.ts prior-art <first test>`, then H `prior-art-verdict`.
   - If someone is active: needs-user `take-it:<item>`. `hand-back` → state `handed back`; `take-it` → continue.

**4. Investigate and fix** (per item):
1. S `worktree.ts create <request>-<item> --base <baseRef> --build artifact` → `waiting for a build slot` until
   it starts.
2. O `investigate-and-fix` → `investigating` while it runs. The report decides:
   - **`fix verified locally`:**
     - each commit → a `patch` event;
     - `landsAfter` → `dep` (source agent, `needs` as text until E4 maps it to a patch);
     - `bugDraft` → kept on the patch, plus needs-user `file-bug:<patch>`.
   - **`left as-is` / `handed back`:** terminal, with the report's summary.
   - **`blocked`:** needs-user with the summary.
3. S `lint-text.ts --kind commit` on each message. Violations → the author is resumed (2 rounds max).
4. O `review-patch`, fresh, per commit → `in critical review`.
   - `ok` → `reviewed`.
   - Findings → `review findings`. The author is resumed with them, then the same reviewer session is resumed to
     verify (3 rounds max, then needs-user).

**5. Stack** (per folder, once every item of the folder is `reviewed` or terminal):
1. S `worktree.ts create <request>-<folder>-stack --build artifact`.
2. S `stack.ts assemble --leave-conflict` with the reviewed commits.
   - A conflict → So `resolve-conflict` in the stack worktree.
   - "Semantic" → needs-user, naming both patches.
3. S `stack.ts deps` → `dep` (textual).
4. H `estimate-review-effort` per patch → its `effort`.
5. S `stack.ts order` (effort, value = the item's `ratePerWeek`, deps), then `stack.ts rewrite` → `stack`.
6. O `review-stack`:
   - findings per patch → that patch's author is resumed, then back to 4.3 for that patch;
   - dependency changes → `dep` / `dep-removed`.
7. S `stack.ts summary` → `stack.summary`, plus `meta-bug` with a draft built from it, plus needs-user `meta-bug`.

**6. Verify on try** (per folder, after 5):
1. So `plan-try-pushes`. Inputs: the un-skip push's command and results, the failures file, and the stack branch.
2. Then dry-run, approval, push and watch as in 2.7–2.8.
3. Each `try-job-failed` test is routed to the patch that touches that test, or else a file in its folder. That
   author is resumed with the failure and the artifact paths. A failure matching no patch → H `triage-try` →
   needs-user.
4. An author's new commit goes through 4.3–4.4, then 5.2, then a new try plan (approval again).
5. Every push of the folder finished and green → `meta bug`.

**7. Bugs.**
- Command `set-bug <patch>` → S `stack.ts rewrite --edits` replaces `Bug XXXXXXX` in that patch's message.
- `set-bug meta` → `meta-bug` with the number, plus the same edit on every patch that has no bug of its own.
- `comment-bug-draft` → So `revise-bug-draft` → the new draft.

**8. Submit.**
1. S `phab.ts reviewers`, then S `stack.ts check --try <the folder's pushes>`.
   - Passing → needs-user `submit:<stack>`, with the command to copy.
   - Failing → the failures are shown on the page; nothing else happens.
2. Command `stack-comments` (from stack-viewer) → each patch's author is resumed with its comments → 4.3–4.4 →
   5.2.
3. When `stack.ts import` sees revisions on every patch → `patch` events with `revision`, `user-done submit`,
   step `review comments`.

**9. Review comments** (top priority):
1. S `phab.ts poll` → `review-status`.
2. Each new comment that isn't done and isn't yours → H `classify-review-comments`.
3. The author is resumed with `address-review` (comments in a file), then S `lint-text.ts` on the messages and the
   replies.
4. O `review-patch` as in 4.4, then `reply-draft` per reply.
5. S `stack.ts rewrite` brings the new commits into the stack. For each changed revision, S `stack.ts interdiff`
   gives the patch's `interdiffFile`.
6. Needs-user `resubmit:<stack>`, with the command to copy for the changed revisions. A revision closed on
   Phabricator → state `landed`.

**10. Landing.** When some patches are accepted:
1. S `stack.ts order --landable`, then `stack.ts rewrite`.
2. Text conflicts → So `resolve-conflict`. Flipped soft deps → H `adapt-soft-dep` (So if H reports it isn't
   trivial).
3. Needs-user `land:<stack>`, with the moz-phab command to copy for the changed revisions.

## Commands

| Command | Effect |
|---|---|
| `new-request` | step 1 |
| `approve-push` | step 2.8 |
| `take-it` / `hand-back` | step 3 |
| `set-bug`, `comment-bug-draft` | step 7 |
| `stack-comments` | step 8 |
| `comment-fix` | the patch's author is resumed with your comment → 4.3–4.4 |
| `tell-factory` | O `recover` → `recovery-plan` |
| `reply-recovery` | the recover session is resumed with your reply → a new `recovery-plan` |
| recovery commands (`retry-job` …) | executed as written. `shell` runs as a job in the given directory |
| `start-now` | a queued request starts ignoring the caps |

## Agent reports still to define

Schemas exist for `investigate-and-fix`, `review-patch` and `recover`. The others, written with this:

| Prompt | Report |
|---|---|
| `parse-request` | `{config, questions}` |
| `classify-annotation` | `{class: scoping\|flakiness\|unclear, reason}` |
| `write-annotation-patches` | `{commits: [runIf, debug]}` |
| `plan-try-pushes` | `{pushes: [{purpose, args: string[]}]}` (the `mach try` arguments) |
| `triage-try` | `{cells: [{test, config, class, logLine}]}` |
| `merge-clusters` | `{groups: FailureGroup[], changes: [{what, reason}]}` |
| `prior-art-verdict` | `{verdict: active\|reuse\|none, bug?, quote}` |
| `resolve-conflict` | `{resolved: boolean, semantic?: string}` |
| `estimate-review-effort` | `{effort: 1-5, reason}` |
| `review-stack` | `{findings: [{patch, text}], addDeps: Dep[], removeDeps: [{patch, needs, reason}]}` |
| `classify-review-comments` | `{comments: [{id, kind}]}` |
| `address-review` | `AddressReviewReport` |
| `adapt-soft-dep` | `{done: boolean, notTrivial?: string}` |
| `revise-bug-draft` | `BugDraft` |

Each also has `feedback`.

## Config added

- `baseRef`: the ref worktrees and stacks start from. It must be central-based, e.g. `origin/main`, never the
  checkout's current branch.
- `phabPollMinutes` (default 10).

## Not in this version

- the RAM/cores scheduler (fixed caps instead);
- health checks;
- cost and claude-profiler links on the page;
- landing detection beyond Phabricator status.
