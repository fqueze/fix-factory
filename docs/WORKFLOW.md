# Fix factory — workflow breakdown

Last 4 weeks with subagents: ~$1.9k for ~100 patches in 4 stacks, from an analysis of the Claude Code transcripts.
**Target: 5× the patches for 1/10 of the cost**, so ~1/50 of today's cost per patch.
73% of wall time was waiting. 96% of the cost was long-lived threads re-reading their context:
logs, `git diff`, status `.md` files.

## Principles

1. **No parent agent.** The Node orchestrator is the parent. All state lives in append-only JSON lines files (one `events.jsonl` per request).
2. **Short agent sessions with JSON output** (`claude -p --json-schema --session-id --max-budget-usd`).
   When an agent needs a build, a test run or a try push, it *returns a request*. The script
   runs it and resumes the session with the result.
3. **Agents can't touch shared state:** no `mach`, no `git stash`/`rebase`/`push`, no `moz-phab`.
   Each agent gets its own named `profiler-cli` session.
4. **Scripts lint what agents write**, enforcing length and format on commit messages, bug drafts and replies.
5. **Intelligence goes where it pays:** investigation (reading profiles to find the race) and
   critical review. Implementing a fix whose cause is already described tries Sonnet first.
6. **Each human gate is one button**, and an agent has already checked what it shows.

Legend: **S** = script · **H** = Haiku · **So** = Sonnet · **O** = Opus · **👤** = you, in the UI.

## A. Intake
| # | Task | Who | Notes |
|---|---|---|---|
| A1 | Submit a request: kind (try push / folder burndown / bugs / D-revision / improve / recover) + free text | 👤 | |
| A2 | Free text → structured config (scope, platforms, constraints) | So | shown to you for confirmation |
| A3 | Collect failures (`fx-tests … --json`, Treeherder) and per-config failure rates | S | the rate becomes each item's **value** |
| A4 | Group failures by shared cause: S clusters exact messages, H merges or splits the ambiguous ones | S + H | runs again whenever new failures arrive |
| A5 | Prior art: Bugzilla, assignee, attached revisions. Someone active → 👤 take it or hand it back | S + H | |
| A6 | Burndown only: list the skip-ifs and find the bug that added each one (`git log -S`). H classifies each as scoping or flakiness | S + H | |
| A7 | Freeze the work list. Items are only ever closed with a terminal state | S | |

## B. First signal (burndown)
| # | Task | Who | Notes |
|---|---|---|---|
| B1 | Generate the `run-if` patch for scoping skips and a `DEBUG - … DO NOT LAND` commit that removes every flakiness skip | S | mechanical, from A6 |
| B2 | Try selection for the un-skip push: configs where the skips applied, `--rebuild` sized to the historical rates | S | |
| B3 | Check the selection against the goal | So | → 👤 approve |
| B4 | Push. As each job fails, download its logs, per-test profiles, resource-usage profile and errorsummary **right away** | S | the profiles feed C2 |

For try-push requests, B4 starts directly on the existing push.

## C. Investigation and repro (one Opus session per work item)
| # | Task | Who | Notes |
|---|---|---|---|
| C1 | Create a worktree outside the checkout and build it (artifact unless the config needs more) | S | scheduled |
| C2 | **Read the profiles to find the race** and propose a repro: a test command plus env and, often, a small code edit that **widens the race** so it's lost more often, committed as `DEBUG -` | **O** | its own `profiler-cli` session |
| C3 | Run the repro request. The number of runs comes from the expected rate. Return counts, failure lines and a local profile, then resume C2 | S | loops |
| C4 | Re-verify the recipe in a clean tree from the commits and measure its repro rate. Store it as a runnable record `{debug commits, command, env, rate}` | S | reused in D2 and after review changes |
| C5 | Summarize how to reproduce in 1–3 sentences | H | goes into the bug, the patch summary and the meta comment |
| C6 | Write the handoff: the cause (leaker named, product or test bug), a fix direction, and **what must be fixed first** (hard dependencies, with a reason) | **O** | short; the session stays resumable |

## D. Fix
| # | Task | Who | Notes |
|---|---|---|---|
| D1 | Implement the fix from the C6 handoff + C4 recipe, in a fresh session | **So**, then O | escalates to O after 2 failed verifications, or if So reports that the direction doesn't hold |
| D2 | Verify: the recipe fails without the fix and passes with it. Runs = `ln(0.01)/ln(1−p)`, with p the recipe's rate (30% → 13 runs, 2% → 228 runs → verify on try instead). Also a normal run + `--verify` without the DEBUG commit | S | |
| D3 | `mach lint --fix`, `mach format` | S | |
| D4 | Commit message from the diff, handoff and repro summary | So | |
| D5 | Lint the message: format, length, no `file:line`/try links/hedging | S | |
| D6 | **Critical review of diff + message** together, with the handoff and the recipe results treated as testimony | **O** (fresh) | after D5, so the message is reviewed too |
| D7 | Findings → back to the D1 author. If the direction itself is wrong → back to the C6 investigator | S → So/O | |
| D8 | Harness footgun reported: fix now / bug later / ignore | 👤 | |

## E. Stack (assembled as soon as fixes arrive, kept up to date)
| # | Task | Who | Notes |
|---|---|---|---|
| E1 | Cherry-pick verified fixes into the request's stack branch and check for conflicts | S | |
| E1b | Update the dependency graph (see **Dependencies**): add the deps declared in C6/D1, detect textual deps, and attach each annotation removal to its patch | S | |
| E2 | Estimate the review effort of each patch: test-only?, size, conceptual difficulty → 1–5 + one line | H | diffstat is an input |
| E3 | Order **easy first**, valuable first within a tier. The only constraint: each patch sits after its hard deps, so a dep is placed just before its first dependent, not at the top. Order changes that flip a soft dep go through E3b | S | value = A3 failure rate |
| E3b | Adapt the patches on both sides of a flipped soft dep, the same way as resolving a rebase conflict. S re-runs D2/D3/D5 on the changed patches | H, So if not trivial | |
| E4 | **Whole-stack review** of the assembled stack: duplicate approaches, conflicting changes, a root cause deferred that another patch could fix, **missing or wrong dependencies**, sanity of the order | **O** | can add or remove deps |
| E5 | Generate the summary table and the meta-bug comment, in stack order, with effort and value columns | S | |

## F. Try (one push per folder)
| # | Task | Who | Notes |
|---|---|---|---|
| F1 | When every item in a folder is fixed or terminal, compute the selection: failing configs, paths from the failure list, rebuild from the rate, `--no-artifact` for C++/Rust | S | refuses duplicates |
| F2 | **Review the selection**: every failing config covered, nothing redundant | So | → 👤 approve, with the review shown |
| F3 | Push and poll. **Iterate on the first failures** without waiting for slow pools (mac shippable) | S | the folder counts as "verified" only once all jobs are done |
| F4 | Each failed job: download its logs/profiles, then build the test × config table (pass / fail / not run) | S | |
| F5 | Sanity-check the table and the jobs `fx-tests` can't parse (harness crashes, hangs with no `test_end`, setup failures). Classify each: fixed / still failing / broken by patch X / unrelated | H, So if unclear | |
| F6 | Broken by patch X → **resume X's author** with the evidence. Still failing → resume the investigator. New unrelated failure → new work item | S | |

## G. Bugs
| # | Task | Who | Notes |
|---|---|---|---|
| G1 | Which bug: product fix → own bug, test-only → meta bug, reuse one when A5 found it. The meta bug needs E3's order and E5's comment | S | |
| G2 | Draft the bug, including the C5 repro summary | So | S lints length |
| G3 | The row shows a **"Bug to file"** link to a prefilled `enter_bug.cgi` | S | |
| G4 | File it, or comment on the draft | 👤 | comments → So revises G2 |
| G5 | When the page becomes visible again after a "Bug to file" click, query Bugzilla once for your recent bugs, then replace `Bug XXXXXXX` | S | no polling |

## H. Submission
| # | Task | Who | Notes |
|---|---|---|---|
| H1 | Reviewers (`mach file-info reviewers`, validated groups) | S (+H tie-break) | |
| H2 | Pre-submit checks: no `WIP`/`DEBUG`, bugs exist and are public, `r=`, try complete and green | S | the button stays disabled until they pass |
| H3 | Review the stack in stack-viewer in a new tab. Comments go to each patch's author session | 👤 → S | `stack-viewer -o`, served same-origin, `mdvReviewComments()` |
| H4 | `moz-phab submit` (one click, server PTY, streamed output) | 👤 | never automatic |
| H5 | Record the D-numbers and post the meta comment | S | |

## I. Review round-trip (top priority: the reviewer still remembers the patch)
| # | Task | Who | Notes |
|---|---|---|---|
| I1 | Poll Phabricator: status, inline comments, suggested edits | S | status chip per patch |
| I2 | Classify each comment: suggested edit / nit / question / change request | H | |
| I3 | Apply suggested edits as written | S | |
| I4 | Change request → resume the author; S re-runs D2–D6 with the stored recipe, and F if behaviour changed | So/O | |
| I5 | Draft replies | So | S lints length |
| I6 | Interdiff: old vs new commit on the same parent | S | |
| I7 | **Copy reply** button + link to Phabricator scrolled to the inline comment (`D…#inline-N`); resubmit with `--single` for the changed revisions only | 👤 | |

## J. Landing
| # | Task | Who | Notes |
|---|---|---|---|
| J1 | Landable set: accepted, comments addressed, every hard dep landed or in the set | S | |
| J2 | Reorder the landable set to the bottom, keeping trailers. Flipped soft deps → E3b. Conflicts → So, or O if semantic | S | lists the revisions whose diff changed → resubmit |
| J3 | `moz-phab reorg`/submit, then Lando | 👤 | one click / link |
| J4 | Detect the landing, close items, clean up worktrees and processes | S | |

## Dependencies

Stored as `dep(patch, needs, kind, reason, source)`, where source is agent, textual or reviewer.

- **Hard: "can't land before"**:
  - a test fix that relies on a product or harness fix;
  - a harness enforcement patch that needs every fix it would otherwise make fail;
  - a patch that only applies on top of another one. S detects this by cherry-picking each patch alone onto
    the base, and does it again whenever the stack changes.

  Agents declare hard deps (C6, D1). E4 and the textual check add or remove them. J1 never lands
  a patch ahead of its hard deps.
- **Soft: "either order works, but the patches change with the order."** Example: three fixes for the
  same test, and the `skip-if` removal has to be in whichever lands last. Other kinds will come up. Agents
  declare soft deps with a reason (D1, E4). S flags candidates: a pair that applies in one order but
  conflicts in the other. When an order change flips a soft dep, an agent adapts the patches (E3b) and
  S flags the revisions whose diff changed for resubmission.
- **Stack view:** every row shows its deps: ⛔ hard (with the reason, and ✓ once the dep has landed)
  and 🔗 soft (with the reason). A **Landable now** filter
  applies J1.

## Scheduler

- Each job declares `{cores, ramGB, exclusive: [objdir, display, ports]}`. **Agents count too**: the
  `claude` process plus each loaded `profiler-cli` profile (~0.6 GB). Estimates get replaced by measured
  peaks, and `systemd-run --user --scope -p MemoryMax=…` contains runaway jobs.
- Admit a job while cores ≤ 64 and MemAvailable − reserve ≥ ramGB. Mochitests are serialized per objdir,
  with one Xvnc per headful run.
- Priority: **review comments** > other work blocking you > items close to done > new items.

## Agent I/O and observability

Brief = prompt + inputs → `claude -p` (stream-json) → the `result` event gives cost, duration and
per-model usage; the JSON output is validated against the schema (invalid → one retry, then 👤). Every
run, script or agent, is a `job` row with timing, cost and the prompt version.
- **Agent profile:** each agent run links to its profile (claude-profiler) and its transcript.
- **Request profile:** a **Profile** button on every request opens a Firefox Profiler profile with one track per
  work item. It has a marker for every job: script calls, builds, test runs, agent runs, try pushes (from push
  to last job), and time spent waiting for you. Agent markers link to that agent's own profile, and
  counters show cumulative cost.

## Feedback and improvement

Improving the factory and its tools is part of the workflow, not a side task.
- Every agent output schema has a `feedback` field: a list of `{target, text}`.
  - *target* is an enum: `fx-tests`, `profiler-cli`, `searchfox-cli`, a factory script, or the station's own prompt/inputs.
  - *text* says what was missing, wrong or useless, or what it had to go find itself.
- S appends each entry, with its job link, to the file for its target. No agent is involved. S also counts per
  station: retries, invalid outputs, escalations and cost.
- From the UI, a target's file becomes an **"improve" request** (factory prompt or script), or is handed to the
  tool's own fix session. That session dedupes as it reads.
- Prompt versions are recorded per job, so a prompt change can be compared on cost and outcome.

## Recovery

- **Known failures, no agent:** a health check covers Claude, Lando, Treeherder, Taskcluster, Bugzilla and
  Phabricator. When a service is down, S pauses the jobs that need it, shows a banner, and retries with backoff.
- **Everything else:** a free-text box ("Tell the factory…"), global or on a request, starts a `recover` agent.
  It gets your text, a state summary of the request, the recent failed jobs and the health checks.
- It proposes a plan made only of **factory actions**: retry a job, change an item's state, skip or redo a step,
  edit the request config, re-push, or open a new request. You approve the plan and S executes it.
- What it couldn't express with those actions becomes feedback (a missing action or a missing state).

## Web UI and tech

Mockup: `mockup.html`.
- **One column of requests:** active ones first, then queued, then finished ones in a collapsed archive.
- **Each request is one line:** a summary, its stage bar, cost, a **Profile** button, and a visible ⚑ badge with
  the action buttons when it needs you.
- **Clicking a request opens it:**
  - its patches, each shown as Phabricator icon (once submitted), then Bug N or "Bug to file", then the first
    line of the commit message;
  - per-reviewer status (✓ accepted / ✗ blocking / … pending), dependencies, effort and value;
  - its try pushes and its recent steps.
- **Overview also has:** recent try pushes (link, one-line purpose, result), the improvement backlog, and a
  header strip with today's numbers and machine load.
- On a phone it's the same single column.

Node 24 + TypeScript, nothing else: `node:http`, JSON lines files, server-sent events, `node:test`.
Pages are rendered by pure functions to HTML strings (tested without a browser), plus a small
client script for live updates. Dependencies: `typescript` and `claude-profiler`.

The scripts and prompts for every step are listed in `COMPONENTS.md`.

## Cost budget

~1/50 of today per patch means roughly **$0.40 per landed patch** on average. Only Opus sessions
(C2, C6, D6, E4) can't be cheap, so the plan relies on:
- one investigation covering every test that shares a cause;
- small briefs and short sessions;
- Sonnet/Haiku/scripts everywhere else;
- 0 tokens spent waiting.

I don't know yet whether $0.40 is reachable. The jobs table will show per-step cost from the first day, so we'll see which step blows the budget.
