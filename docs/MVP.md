# Fix factory — first version

`WORKFLOW.md` is the long-term design. This file is the first version, in pipeline order.

Investigation and fixing stay close to today: one Opus agent per failure, in its own worktree, following
`debug-a-test-failure` and running `mach` itself. What changes: no parent agent. Scripts start every agent,
including the reviewers the parent used to start. Status, try pushes, bugs, submission, review comments and
reorgs move to scripts and cheap agents, with a web page instead of the terminal.

Who: **S** = script · **H** = Haiku · **So** = Sonnet · **O** = Opus · **👤** = you, in the web page.

## How the pieces talk

Three kinds of processes: the **web server** (the page), the **orchestrator** (decides and starts the next job),
and **jobs** (scripts, builds, agents, try watchers). They share no memory, only two kinds of append-only JSON lines
files:
- **`events.jsonl`, one per request:** everything that happened (state changes, job start/end, agent reports,
  decisions). The orchestrator writes it, and folds it into the current state at startup. The web server reads it
  and tails it for live updates. The request profile is built from it.
- **`commands.jsonl`:** everything you asked for. Each button in the page appends a command, e.g.
  `{"cmd": "approve-push", "push": …}` or `{"cmd": "set-bug", "patch": …, "bug": 2081216}`. The orchestrator executes
  commands in order and records the outcome in `events.jsonl`.

The volume is small (hundreds of patches, thousands of jobs), so no database. The files can be grepped, and agents
can read them.

## Pipeline

### 1. Request
| Step | Who | How |
|---|---|---|
| Type it in plain text in the main "Tell the factory…" box, e.g. "burn down dom/base/test, skip Android" | 👤 | |
| Route it: about an existing request → `recover.md` on that request; otherwise a new request with its kind, folder or revision, and config, shown to you | So | `route-request.md` |

### 2. First signal (burndown only; a try-push request starts at step 3 with its push)
| Step | Who | How |
|---|---|---|
| List the folder's skip-ifs with the bug that added each one | S | `annotations.ts list` |
| Classify each skip as scoping or flakiness | H | `classify-annotation.md` |
| Write the `run-if` commit and the `DEBUG - … DO NOT LAND` commit that removes the flakiness skips | So | `write-annotation-patches.md` |
| Critical review of the `run-if` commit (a wrong `run-if` silently disables a test) | O | `review-patch.md` |
| Plan the un-skip push from each test's per-config history | So | `plan-try-pushes.md` |
| Dry-run it and show the task list | S | `try.ts dry-run` |
| Approve | 👤 | |
| Push and watch. Fetch logs and profiles of each failed job as it arrives | S | `try.ts push`, `try.ts watch`, `artifacts.ts` |

### 3. Work list
| Step | Who | How |
|---|---|---|
| Per test × config results, including jobs `fx-tests` couldn't parse | S | `failures.ts try-table` |
| Look at failed jobs `fx-tests` couldn't parse | H | `triage-try.md` |
| Group failures that share a specific message | S, then H | `failures.ts cluster`, `merge-clusters.md` |
| Prior art for each group: open bug to reuse, or someone already on it | S, then H | `bugzilla.ts prior-art`, `prior-art-verdict.md` |
| Someone active: take it or hand it back | 👤 | |

### 4. Investigate and fix (one per group, as today)
| Step | Who | How |
|---|---|---|
| Worktree + build (capped at M concurrent builds) | S | `worktree.ts create` |
| Investigate, fix, write the commit message. The run ends with a JSON report: state, cause, how it was verified, a bug draft if one is needed, the patches this one must land after, and feedback. The script records it in `events.jsonl`, and the reviewer gets it | O | `investigate-and-fix.md` |
| A bug draft shows up right away as a **"Bug to file"** link on the patch's row (prefilled `enter_bug.cgi`), checked first | S | `lint-text.ts --kind bug`, `bugzilla.ts enter-url` |
| File it and paste the number, or comment on the draft, in the same box. A number replaces `Bug XXXXXXX` in the commit message. Comments → So `revise-bug-draft.md` | 👤 | `stack.ts rewrite` |
| Check the commit message's format and length | S | `lint-text.ts` |
| **Critical review** of diff + message, started by the script as soon as the author reports "fix verified locally" | O (fresh) | `review-patch.md` |
| Findings → the author is resumed, then re-reviewed until `ok` | S → O | |

### 5. Stack (per folder, once every group in it is fixed or closed)
| Step | Who | How |
|---|---|---|
| Cherry-pick the reviewed fixes onto the stack branch. Text conflicts → So, approach conflicts → author | S | `stack.ts assemble`, `resolve-conflict.md` |
| Dependencies: those declared by authors, plus patches that only apply on top of another | S | `stack.ts deps` |
| Review effort of each patch, 1–5 | H | `estimate-review-effort.md` |
| Order: easy first, valuable first (failure rate), each patch after its hard deps. Fully automatic | S | `stack.ts order` |
| **Stack review**: duplicate approaches, conflicting changes, deferred root causes, missing deps | O | `review-stack.md` |
| Summary table + meta-bug comment in stack order, with effort, value, repro | S | `stack.ts summary` |

### 6. Verify on try
| Step | Who | How |
|---|---|---|
| Plan the pushes. Inputs: the un-skip push (selection and results), so results are comparable; the failures; which patches change product code, since those need their own coverage. Often more than one push, each with a one-line purpose | So | `plan-try-pushes.md` |
| Dry-run each push | S | `try.ts dry-run` |
| Approve | 👤 | |
| Push, watch, results table. Work starts on the first failures, without waiting for slow mac pools | S | `try.ts`, `failures.ts try-table` |
| Route each failure to the author whose patch touches that test or its folder | S | |
| Look at unparsed jobs and failures matching no patch | H | `triage-try.md` → 👤 |

### 7. Meta bug (before submission: every patch needs a number)
| Step | Who | How |
|---|---|---|
| Meta-bug draft from the stack summary, shown as "Bug to file" on the request | S | `stack.ts summary`, `bugzilla.ts enter-url` |
| File it and paste the number. It replaces the placeholder in every test-only patch | 👤 | `stack.ts rewrite` |
| Pre-submit checks block submission while any `Bug XXXXXXX` is left | S | `stack.ts check` |

### 8. Submit
| Step | Who | How |
|---|---|---|
| Reviewers | S | `phab.ts reviewers` |
| Pre-submit checks: no WIP/DEBUG, real public bugs, `r=`, try complete and green | S | `stack.ts check` |
| Review in stack-viewer. Comments go to each patch's author | 👤 → O | |
| Copy the `moz-phab submit` command (with the `cd` to the stack's worktree), run it yourself, then copy the meta-bug comment. The next poll reads the new `Differential Revision:` trailers | 👤 | `stack.ts import`, `phab.ts poll` |

### 9. Review comments (highest priority)
| Step | Who | How |
|---|---|---|
| Poll: per-reviewer status, inline comments, suggested edits | S | `phab.ts poll` |
| Classify each comment | H | `classify-review-comments.md` |
| Address the comments, suggested edits included (author resumed). The author also returns replies, only where the code doesn't speak for itself (answers, disagreements, a different approach), never "Done.". Then lint (replies included) + critical review again | O | `address-review.md`, `lint-text.ts`, `review-patch.md` |
| Interdiff | S | `stack.ts interdiff` |
| Copy reply, open the inline comment, copy the resubmit command (changed revisions only) and run it | 👤 | |

### 10. Landing
| Step | Who | How |
|---|---|---|
| Move accepted patches whose hard deps are met to the bottom, keeping trailers. Text conflicts → So, flipped soft deps → H/So, approach conflicts → author | S | `stack.ts order --landable`, `stack.ts rewrite`, `adapt-soft-dep.md` |
| Copy and run the `moz-phab submit` command for the changed revisions, then land | 👤 | |

### Throughout
- **Status page:** requests (one line each, ⚑ when you're needed), stacks, try pushes with purpose and result.
- **Request profile** (from the start, to see whether the orchestration did what it should): a Firefox Profiler
  profile built from `events.jsonl`, with a marker for every step: script runs, builds, agent runs, try pushes,
  time waiting for you.
- **Tool feedback, as in today's skills:** every agent's JSON output has a `feedback` list for problems with
  `fx-tests`, `profiler-cli` or a factory script, and for anything missing from what we gave it. A script appends
  each entry, with a link to the agent run, to one file per tool.
- **"Tell the factory…"**: see Recovery below.
- **Web server** always on the same port, `"port": 4300` in `factory.config.json`, listening on all interfaces so the page
  can be opened from another machine.
- **Caps:** N agents and M builds at once.
- **Agent launch command** in `factory.config.json`, e.g. `"claudeCommand": ["mozsb", "claude"]` (sandbox,
  permission prompts disabled). The factory appends `-p --output-format stream-json --session-id … --model …`.
  Transcripts end up in `~/.claude`. To check before building: `mozsb` passes those arguments through and lets
  us read stdout.

## Recovery ("Tell the factory…")

For anything the pipeline didn't anticipate: an unusual instruction, a service that was down, a stuck agent, or
state that looks wrong.

1. You type free text, either in the global box or on a request.
2. The script starts an Opus agent (`recover.md`) in the factory's state directory. It can read everything: the
   request's `events.jsonl`, job output files, agent transcripts, worktrees (`git log`/`diff`), and the read-only
   subcommands of the factory CLIs. **It can't change anything.**
3. It returns a plan: a list of **factory commands**, each with a one-sentence reason. These are the same commands your
   buttons append to `commands.jsonl`:
   - `retry-job`, `cancel-job`;
   - `resume-agent` (item, message), `start-agent` (item, prompt);
   - `set-state` (item, state);
   - `set-bug` (patch, number);
   - `redo-step` (item, step), for example re-plan the try pushes;
   - `edit-config` (request);
   - `shell` (worktree, command), the escape hatch, shown verbatim.
4. The plan shows up on the request with a checkbox per command. You approve all or some of them, and they're
   appended to `commands.jsonl`. The orchestrator executes them exactly as if you had clicked, so there is only one
   execution path. Replying in the box instead resumes the same agent session, which returns a revised plan.
5. What it can't express as a command goes in `cannotDo`. You handle it by hand, and if it comes up again it becomes
   a new command type.

Examples:
- *"Lando was down this morning, re-push what failed"* → it finds the pushes whose job ended with a Lando error →
  `retry-job` on each.
- *"browser_foo's agent has been at it for 6 hours"* → it reads the transcript tail → `resume-agent` with "stop and
  report what you have", or `cancel-job` + `start-agent` with a note on what to avoid.
- *"Bug 2081300 is a duplicate, use 2081216"* → `set-bug` on the affected patches.

## Build order

1. **Steps 1–6 and the status page.** First usable result: a request entered in the page ends as a verified,
   reviewed, ordered stack.
2. **Steps 7–10**, built while the first stack is being worked on, so they're ready when it is.
   `stack.ts import` adopts the stacks already in review, so steps 9–10 can be used on them right away.

## Later
1. Cost and claude-profiler link for every agent run.
2. Investigation split from fixing: Opus writes a handoff, Sonnet implements (`implement-fix.md`).
3. Agents stop running `mach`: the scripts run repro and verification (`run-tests.ts`, repro recipes, `--compare`).
4. Scheduler with a cores/RAM model instead of fixed caps.
5. A configurable Claude config directory (`CLAUDE_CONFIG_DIR`) for agents, with the factory finding transcripts there.
6. "Stopped failing" check before investigating, to save Opus runs on failures that are already fixed (4 of 7 in the
   first burndown).
   - **Decide (script):** take `fx-tests` history: the last failure on central, and *n* runs since. With the old rate *p*,
     (1−p)ⁿ < 1% → close the group as "stopped failing on <date>, n runs since".
   - **Name the fix (script + Haiku):** list the commits landed shortly before the last failure that touch the test's
     folder or mention the test; Haiku picks the likely one and its bug.
   - Fixes elsewhere (e.g. a leaker in another test) show as "cause not identified".

## Updating the factory without stopping it

Every process can be restarted on its own without losing anything.

State lives in the two files described in "How the pieces talk" above.

**Separate processes:**
- The web server holds no state, so you can restart it whenever you like; the page reconnects on its own.
- The orchestrator rebuilds its state from the files when it starts.
- Jobs (agents, builds, tests, try watchers) are detached processes. Output goes to a file, and a wrapper writes
  the exit code when they end. An orchestrator restart doesn't touch them. On startup it checks each running job's
  pid and start time, re-attaches, and collects results from jobs that ended while it was down.
- Scripts and prompts are read fresh by every new job. Running jobs finish on the version they started with.
  Each job records its code and prompt version.

**What couples them:** the event and command formats, and the scripts' JSON output. Only add fields, never
rename them.

**Deploying:**
- The factory runs from `releases/<sha>/` behind a `current` symlink. A deploy checks out the new sha, runs the
  tests, swaps the symlink, and restarts the server and orchestrator.
- Rollback swaps the symlink back.
- To try a change first, run a second instance on a copy of the state with `--dry-run`. It makes no try pushes,
  no Phabricator or Bugzilla calls, and starts no agents.
