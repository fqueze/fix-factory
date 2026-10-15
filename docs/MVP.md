# Fix factory — first version

`WORKFLOW.md` is the long-term design. This file is the first version, in pipeline order.

Investigation and fixing stay close to today: one Opus agent per failure, in its own worktree, following
`debug-a-test-failure` and running `mach` itself. What changes: no parent agent. Scripts start every agent,
including the reviewers the parent used to start. Status, try pushes, bugs, submission, review comments and
reorgs move to scripts and cheap agents, with a web page instead of the terminal.

Who: **S** = script · **H** = Haiku · **So** = Sonnet · **O** = Opus · **👤** = you, in the web page.

## Pipeline

### 1. Request
| Step | Who | How |
|---|---|---|
| Enter a request: a folder to burn down, or a try push to fix, plus free text | 👤 | |
| Turn the free text into a config (scope, platforms, constraints), shown to you | So | `parse-request.md` |

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
| Investigate, fix, write the commit message. Also draft a bug if one is needed, list the patches this one must land after, and keep the `sessionlog.md` state line current | O | `investigate-and-fix.md` |
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

### 7. Bugs (before submission: patches need numbers)
| Step | Who | How |
|---|---|---|
| Check the authors' bug drafts and the meta-bug draft (from the summary) | S | `lint-text.ts --kind bug` |
| "Bug to file" links to a prefilled `enter_bug.cgi` | S | `bugzilla.ts enter-url` |
| File it, or comment on the draft | 👤 | comments → So `revise-bug-draft.md` |
| On return to the tab, find the new bug, then replace `Bug XXXXXXX` in the commit messages | S | `bugzilla.ts find-filed`, `stack.ts rewrite` |

### 8. Submit
| Step | Who | How |
|---|---|---|
| Reviewers | S | `phab.ts reviewers` |
| Pre-submit checks: no WIP/DEBUG, real public bugs, `r=`, try complete and green | S | `stack.ts check` |
| Review in stack-viewer. Comments go to each patch's author | 👤 → O | |
| Click `moz-phab submit`, then copy the meta-bug comment | 👤 | `phab.ts run-moz-phab` |

### 9. Review comments (highest priority)
| Step | Who | How |
|---|---|---|
| Poll: per-reviewer status, inline comments, suggested edits | S | `phab.ts poll` |
| Classify each comment | H | `classify-review-comments.md` |
| Apply suggested edits as written | S | `stack.ts rewrite` |
| Address change requests (author resumed), then lint + critical review again | O | `address-review.md`, `review-patch.md` |
| Interdiff | S | `stack.ts interdiff` |
| Draft replies | So | `draft-reply.md` + `lint-text.ts` |
| Copy reply, open the inline comment, click resubmit (changed revisions only) | 👤 | |

### 10. Landing
| Step | Who | How |
|---|---|---|
| Move accepted patches whose hard deps are met to the bottom, keeping trailers. Text conflicts → So, flipped soft deps → H/So, approach conflicts → author | S | `stack.ts order --landable`, `stack.ts rewrite`, `adapt-soft-dep.md` |
| Click `moz-phab submit` for the changed revisions, then land | 👤 | |

### Throughout
- **Status page:** requests (one line each, ⚑ when you're needed), stacks, try pushes with purpose and result,
  cost and profile link of every agent run.
- **Tool feedback, as in today's skills:** every agent's JSON output has a `feedback` list for problems with
  `fx-tests`, `profiler-cli` or a factory script, and for anything missing from what we gave it. A script appends
  each entry, with a link to the agent run, to one file per tool.
- **"Tell the factory…"** free text → O `recover.md` proposes a plan, 👤 approves.
- **Caps:** N agents and M builds at once.

## Build order

1. **Steps 1–6 and the status page.** First usable result: a request entered in the page ends as a verified,
   reviewed, ordered stack.
2. **Steps 7–10**, built while the first stack is being worked on, so they're ready when it is.
   `stack.ts import` adopts the stacks already in review, so steps 9–10 can be used on them right away.

## Later
1. Investigation split from fixing: Opus writes a handoff, Sonnet implements (`implement-fix.md`).
2. Agents stop running `mach`: the scripts run repro and verification (`run-tests.ts`, repro recipes, `--compare`).
3. Scheduler with a cores/RAM model instead of fixed caps.
4. Request profile with a marker for every step.

## Updating the factory without stopping it

Every process can be restarted on its own without losing anything.

**State is append-only JSON lines files, not a database.** The volume is small: hundreds of patches and
thousands of jobs. A request's `events.jsonl` holds every state change, job start/end, cost and decision. The
orchestrator folds it into the current state at startup. The web server reads the same files and tails them for
live updates. Your clicks go to `commands.jsonl`. The files can be grepped, and agents can read them.

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
