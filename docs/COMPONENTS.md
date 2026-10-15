# Fix factory — scripts and prompts

The step IDs in brackets refer to `WORKFLOW.md`.

- **Scripts** are TypeScript run directly by Node 24, under `scripts/`. Each one is a CLI that prints JSON, so it can be tested and run by hand.
- **Prompts** live under `prompts/` and are reviewed by you before use. `{braces}` mark inputs filled in by the orchestrator.
- Every agent's output schema also includes the shared `feedback` field, a list of `{target, text}` (see WORKFLOW.md), so it isn't repeated in the prompts.

## Scripts

Ten CLIs, each with subcommands. One file per tool, with modules inside it as needed.

| Script | Subcommands (steps) | Notes |
|---|---|---|
| `failures.ts` | `collect <rev\|folder>` [A3] · `history <test>` [A3, D2] · `cluster` [A4] · `try-table <rev>` [F4] | Everything built on `fx-tests --json`. `cluster` strips numbers, paths, timings and pids, and never groups generic messages. `try-table` uses `--all-jobs`, marks cells pass / fail / **not run**, and lists the jobs fx-tests couldn't parse |
| `artifacts.ts` | `fetch <taskId>` [B4, F4] | Logs, errorsummary, per-test and resource-usage profiles into the cache. Checks the `artifact` markers so nothing is missed |
| `annotations.ts` | `list <folder>` [A6] · `write --run-if --debug-unskip` [B1] | Skip-ifs with the bug that added each one (`git log -S`) and whether the condition is dead. `write` makes the run-if and DEBUG un-skip commits |
| `bugzilla.ts` | `prior-art <test>` [A5] · `enter-url <draft>` [G3] · `find-filed <draft>` [G5] (later) | Facts only, no verdict. `find-filed` runs once, when the page is visible again after a "Bug to file" click |
| `worktree.ts` | `create --build artifact\|debug\|full` [C1] · `lint` [D3] · `remove` [J4] | Every `mach` call except tests. Worktrees go outside the checkout. `remove` also kills the worktree's processes |
| `run-tests.ts` | `run <request>` [C3] · `--recipe R --clean --measure` [C4] · `--recipe R --compare <fix>` [D2] | One runner. Results come from the mozlog raw log. `--measure` gives the repro rate. `--compare` runs without and with the fix, `ln(0.01)/ln(1−p)` times each, plus a plain `--verify` without the DEBUG commits. Says "use try" when the needed run count is too high |
| `lint-text.ts` | `--kind commit\|bug\|reply` [D5, G2, I5] | Format, length, banned patterns (`file:line`, try links, hedging) |
| `stack.ts` | `import` (MVP) · `assemble` [E1] · `deps` [E1b] · `order [--landable]` [E3, J1, J2] · `rewrite` [E3, G5, I3, J2] · `interdiff` [I6] · `check` [H2] · `summary` [E5] | Every git stack operation. `rewrite` takes an order plus edits (message edits such as bug numbers, suggested edits from reviewers), keeps trailers, and reports which revisions changed |
| `try.ts` | `dry-run` · `push` [B4, F3] · `watch` [B4, F3] · `select` [B2, F1] (later) | `dry-run` gives the task list of a planned push and refuses a duplicate of a pending one. `watch` emits an event per finished job, so work starts on the first failures. `select` (later) computes the selection without an agent |
| `phab.ts` | `poll` [I1] · `reviewers` [H1] · `run-moz-phab` [H4, I7, J3] | `poll` gets per-reviewer status, inline comment ids and suggested-edit text (from `phab-suggestions.py`). `run-moz-phab` runs only on your click, in a PTY streamed to the page |

Factory runtime (long-running, not CLIs):

| Module | Role |
|---|---|
| `orchestrator.ts` | State machine choosing the next job for each work item. Pure functions over the folded `events.jsonl` state |
| `scheduler.ts` | Admits jobs by cores, RAM (agents and `profiler-cli` included) and exclusive resources. Review comments come first. Also runs the health checks and pauses job types whose service is down |
| `agent-run.ts` | Runs `claude -p` with prompt, schema, model, budget and session id. Validates the output, records cost and duration, appends `feedback` entries to each target's file, and resumes sessions |
| `server.ts` | Web UI, SSE updates, stack-viewer pages served same-origin, request profiles built from the job rows |

## Prompts

### `parse-request.md` (Sonnet) [A2]
> Turn this request into the JSON config defined by the schema. Kind: {kind}. Text: {text}. Only include
> constraints the text states, and leave fields empty rather than guessing. List anything ambiguous in `questions`.

### `merge-clusters.md` (Haiku) [A4]
> These failures were grouped by exact message: {clusters}. Merge clusters whose messages are the same
> specific failure with different numbers, names or paths. Split clusters that only look alike. A generic message
> such as "Test timed out" is never a shared cause. Give a one-line reason for each change.

### `prior-art-verdict.md` (Haiku) [A5]
> Facts about existing bugs and revisions for {test}: {facts}. Decide whether someone is actively working on
> it (activity in the last 30 days, or a revision in review), whether there's an open bug we should reuse, or
> neither. Quote the fact your verdict rests on.

### `classify-annotation.md` (Haiku) [A6]
> The annotation `{annotation}` in {manifest} was added in bug {bug} ("{summary}"), whose first comment is: {comment}.
> Is it **scoping** (the test can't work in that config, so it should become `run-if`) or **flakiness** (it fails
> intermittently there)? Answer `unclear` with one sentence if neither fits.

### `review-try-selection.md` (Sonnet) [B3, F2]
> This push must answer: {goal}. These failures must be covered: {failure table}. The proposed command and
> dry-run task list are: {dry run}. Report every failing config or test path that isn't covered, redundant tasks,
> and whether the rebuild counts match the failure rates. Approve only if there's nothing to report.

### `investigate-and-fix.md` (Opus, MVP only) [C2–D1 as done today]
> Fix {test} in {worktree}, following debug-a-test-failure and subagent-brief.md. The failure: {failure summary}.
> Commit the fix with a message following the commit-message skill, using `Bug XXXXXXX` if the fix needs a bug
> of its own. End with the JSON report: state, cause, how you verified it, a bug draft (bug-filing skill) if one is
> needed, and any patch yours must land after.

### `write-annotation-patches.md` (Sonnet) [B1, MVP]
> Here are the skip-ifs of {folder}, each classified as scoping or flakiness: {annotations}. Write two commits.
> The first turns each scoping skip into the equivalent `run-if`. The second is
> `DEBUG - Remove flakiness skip-if annotations in {folder} to reproduce on try. DO NOT LAND.` and removes every flakiness skip.
> Change nothing else.

### `plan-try-pushes.md` (Sonnet) [B2, F1, MVP]
> Plan the try pushes for: {goal}. Inputs: the failures to cover with their per-config rates ({failures}), the
> stack's patches with their diffstats ({patches}), and the earlier un-skip push's command and results
> ({initial push}). Follow the push-to-try skill. Keep the configs and paths comparable with the un-skip push,
> and add a separate push when a patch changes product code that those jobs don't cover. Give each push its
> `mach try` command, rebuild count, and one-line purpose.

### `investigate-failure.md` (Opus) [C2] — needs the **investigate-race** skill
> Find the cause of {failure summary} in {test}, following the investigate-race skill. Evidence: profiles and
> logs in {evidence dir}, history in {history table}. Don't run anything: when you need a run, return a repro
> request, optionally with a DEBUG commit that widens the race. Stop when a recipe reproduces the failure.

### `write-handoff.md` (Opus, same session) [C6]
> The recipe reproduced at {rate}. Write the handoff: the cause in at most 3 sentences (name the leaker; say
> whether it's a product, test or harness bug), the fix direction, and what has to be fixed first, with a reason.
> Don't write the fix.

### `repro-summary.md` (Haiku) [C5]
> This recipe was verified at {rate}: {recipe}. Write 1 to 3 sentences that a reviewer could follow to reproduce
> the failure. Steps only: no mechanism, no speculation.

### `implement-fix.md` (Sonnet, Opus on escalation) [D1]
> Implement the fix described in this handoff: {handoff}. Fix the cause it names, not the symptom. If the
> direction doesn't hold once you've read the code, stop and say why instead of improvising. Commit as
> `WIP - <summary>`. List any patch yours must land after, and any whose content would have to change if the
> order changed.

### `commit-message.md` (Sonnet) [D4]
> Write the commit message for {sha} following the commit-message skill. Bug: {bug or XXXXXXX}, reviewer:
> {reviewer}. Use the diff, this handoff ({handoff}) and this repro summary ({repro}). Return only the message.

### `review-patch.md` (Opus, fresh) [D6] — needs the **review-patch** skill
> Review commit {sha}, both diff and message, following the review-patch skill. The handoff and test results
> are the author's testimony: check them against the code instead of trusting them. Report each finding as
> must-fix or nit, or return `ok`.

### `estimate-review-effort.md` (Haiku) [E2]
> Rate the effort of reviewing this patch from 1 (short, test-only, obvious) to 5 (subtle product change).
> Diffstat: {diffstat}. Message: {message}. Diff: {diff}. Justify it in one line.

### `review-stack.md` (Opus) [E4]
> Here is an assembled stack: commit messages, diffstats and dependencies, in order: {stack}. Look for two
> patches solving the same problem differently, a shared helper changed under another patch, a root cause
> deferred that another patch was in a position to fix, and missing or wrong dependencies. Return findings per
> patch, plus dependency additions and removals with a reason.

### `adapt-soft-dep.md` (Haiku, Sonnet if not trivial) [E3b]
> Patches {A} and {B} swapped order, and the soft dependency between them says: {reason}. Adjust both
> patches so each is correct in the new order and the end result after both is unchanged, the way you'd
> resolve a rebase conflict. Change nothing else.

### `resolve-conflict.md` (Sonnet, Opus if semantic) [J2]
> Rebasing {sha} onto {base} conflicts in {files}. Resolve it, keeping the intent of both sides. If the conflict
> is semantic (the patch's approach no longer fits the new base), stop and explain instead.

### `triage-try.md` (Haiku, Sonnet if unclear) [F5]
> Results of try push {rev} (goal: {goal}): {table}. Logs of jobs fx-tests couldn't parse: {log excerpts}. For each
> failing or not-run cell, classify it as fixed, still failing, broken by patch X, unrelated pre-existing, or infra,
> and cite the log line it rests on.

### `draft-bug.md` (Sonnet) [G2] — uses the **bug-filing** skill
> Draft a bug for this cause: {handoff}, in {product}::{component}, following the bug-filing skill. The
> description has at most 8 lines: symptom, how to reproduce ({repro}), cause, ask.

### `revise-bug-draft.md` (Sonnet) [G4]
> Revise this bug draft according to the user's comments, changing nothing they didn't ask about. Draft:
> {draft}. Comments: {comments}.

### `classify-review-comments.md` (Haiku) [I2]
> Classify each inline comment on {revision} as suggested edit, nit, question, or change request. For a
> question, say whether it implies a code change.

### `address-review.md` (resumes the author) [I4]
> The reviewer left these comments on your patch: {comments}. Make the requested changes and nits in code,
> and draft an answer for each question. Keep the `Differential Revision:` trailer.

### `draft-reply.md` (Sonnet) [I5]
> Draft a reply to this review comment: {comment}, given what changed: {interdiff}. Write the shortest
> complete answer; "Done." is right when the change speaks for itself. Never claim anything that wasn't verified.

### `recover.md` (Opus) [Recovery]
> The user says: {text}. The state of request {id} is in {state dir}: read `events.jsonl`, job outputs and
> transcripts there before deciding anything. Return a plan made only of the factory commands in the schema, with
> one sentence per command saying why. Put what can't be done with those commands in `cannot_do`, and ask
> the user anything the files don't tell you.

## Skills these prompts depend on

Each prompt stayed at 5 sentences or fewer by pointing at a skill for the long part:

- **investigate-race** (new): merge `debug-a-test-failure` and `diagnose-failures-from-profiles`, plus what to
  read in a profile, how to widen a race with a DEBUG edit, and the repro request format. Drop everything about
  worktrees, builds and running tests, since the factory now does those.
- **review-patch** (new): the checklist from `orchestrate-parallel-fixes`' critical review (wallpaper fixes,
  unverified mechanisms, padding, follow-up bugs used as an excuse, citations that trace back to one source).
- **commit-message** and **bug-filing**: existing, used as they are.

`orchestrate-parallel-fixes`, `burn-down-flakiness` and `push-to-try` become code (`orchestrator.ts`,
`try.ts select`). Their rules turn into test cases.
