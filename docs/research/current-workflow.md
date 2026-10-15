# Current fix workflow — digest

Sources: `/build/prompts/skills/` (symlinked into `~/.claude/skills/`), `/build/FLAKINESS_BURNDOWN.md` (superseded
but most detailed), `/build/prompts/`, `/build/docs/`. **BD** = runbook
`FLAKINESS_BURNDOWN.md`, **OPF** = `orchestrate-parallel-fixes`, **DTF** = `debug-a-test-failure`,
**BDF** = `burn-down-flakiness`, **PTT** = `push-to-try`, **CM** = `commit-message`,
**DFP** = `diagnose-failures-from-profiles`. M = mechanical, J = judgment.

## 1. Steps, request → landing

### A. Setup / intake
1. **Tool check** (M). `command -v fx-tests || npm install -g github:mozilla/aretestsfastyet`;
   `npm install -g @firefox-devtools/profiler-cli@latest`; `treeherder-cli`, `searchfox-cli` (via
   `./mach bootstrap`). Check `moz` MCP server (Firefox `.mcp.json`) is connected (BD §0).
2. **Parse request** (J). Kinds: folder burndown; top-N intermittents (`fx-tests intermittent`);
   try push revision; named bugs / D-revisions (read via `mcp__moz__get_bugzilla_bug`,
   `mcp__moz__get_phabricator_revision`); platform. Known scope ⇒ skip surveys (BD §1).
3. **Create session log** (M). Parent `artifacts/sessionlog.md`, append-only: verbatim prompt, dated user
   instructions, one row per try push, dated decisions (OPF). 

### B. Scoping (build the test list)
4. **Folder ranking** (M) if no folder: `fx-tests flaky` (no path) or
   `fx-tests issues --harness mochitest|xpcshell --group-by directory [--type fail --type timeout] --limit 20`.
5. **Failure survey** (M query, J interpretation). `fx-tests flaky <folder>`;
   `fx-tests failures --path <folder> --limit 0` (group by message — one message across tests = one bug); per test `fx-tests test <path> [--executions|--coverage|--history|--task-ids|--profiles|--bugs]`. DFP: `fx-tests issues --type fail --type timeout --type crash --group-by test --limit 0`; try: `fx-tests try <rev>`.
6. **Skips / annotation audit** (M listing, J classification). `fx-tests skips --harness <h> --path <folder>
   --limit 0 [--include-run-if] [--group-by test]`; read manifests as on main (`git show <main>:<manifest>`);
   `git log -S "<test>" -- <manifest>` / `git log -p --follow` to find the adding bug; classify:
   scoping→`run-if`, flakiness→un-skip, perma-fail (in scope), instrumentation (must name mechanism).
   Reachability = platform × suite via `taskcluster/test_configs/test-sets.yml` + `test-platforms.yml`.
7. **Prior-art check** (M fetch, J verdict). `fx-tests intermittent --path <test> | --bug N | --test <path>`;
   Bugzilla REST quicksearch `/rest/bug?quicksearch=<test>`;
   comments `/rest/bug/<N>/comment` (filter bots); `git log --oneline -- <test>`; sibling skip-if in same
   manifest. Verdict: active assignee/revision in review → ask user (hand back); stalled WIP → proceed, read
   patch; open unassigned → reuse bug number.
8. **Freeze test list** (M). Every failing + annotated test gets a numbered entry; never deleted; count in header.

### C. Annotation patches + first push
9. **Integration worktree** (M). 
   `new-worktree.sh <name> [--debug] [--no-artifact] [--base <ref>] [--no-build]` →
   `artifacts/worktrees/<name>`, writes mozconfig, `./mach build`, smoke test
   (`./mach mochitest --headless testing/mochitest/tests/Harness_sanity/test_sanity.html`). Artifact ≈1 min, full ≈5 min.
10. **Patch A + Patch B** (J, one agent — same manifests). A: `WIP - Scope <tests> ... with run-if.` (landable);
    B: `DEBUG - Remove flakiness skip-if annotations in <folder> to reproduce on try. DO NOT LAND.` (last in
    stack, never `fail-if`). Parent reviews diff (wrong `run-if` = silently disabled test).
11. **Choose try selection** (J; see §4). Write `artifacts/try-command-N.sh`.
12. **Dry run** (M): `./mach try fuzzy -q "..." [-q ...] --rebuild N [--no-artifact] --no-push <paths>`.
13. **HUMAN: approve push** with task list + annotation audit.
14. **Push** (M): same command without `--no-push`, `-m "WIP - flakiness burndown: <folder>"`. Log row
    immediately (rev, link `https://treeherder.mozilla.org/jobs?repo=try&revision=<rev>`, state `waiting`).
    Re-push: `./mach try again [--index N] [--list]` only if stack frontend-only.

### D. Investigation (per failure, parallel, ~10 at a time)
15. **Per-failure worktree** (M). `new-worktree.sh <name> [--base integration]` in background; brief is a
    pointer: `Fix <test> in <worktree>, follow subagent-brief.md and debug-a-test-failure` (OPF). Group tests
    sharing a specific message into one agent.
16. **Gather** (M+J). `fx-tests test ...` as step 5; read bug, `regressed_by`, WIP patches.
17. **Get profiles** (M). Try: `fx-tests try <rev> --profiles --task-ids`; trunk: `fx-tests task <taskId> --profiles`; artifact listing
    `curl -sL https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/<id>/runs/<n>/artifacts`;
    per-test profile `.../artifacts/public/test_info/profile_<test>.json` (and `-2` = retry);
    job timeline `.../public/test_info/profile_resource-usage.json` (Test spans, FAIL/ERROR/CRASH markers,
    `artifact` markers list every upload). Always `curl -L`.  Logs: `.../public/logs/live_backing.log`.
18. **Analyse profiles** (J, expensive). `profiler-cli load --session $S <url>`; `thread markers --session $S
    --category Test --search <file> --list`; markers `DOMEvent`, `NotifyObservers`, `SetNeedStyleFlush`; `zoom push`, `thread samples`, `screenshots`; links via `profile-link.py`. Max 2 profiles loaded (~0.6 GB each).
19. **Reproduce locally** (M runs, J design). `./mach mochitest --headless <test>`; whole manifest +
    `--start-at/--end-at` bisect; `--run-until-failure --repeat 20` (mochitest); `./mach xpcshell-test
    --sequential --repeat 20`; `--verify`; `MOZ_CHAOSMODE=0x7|0xfb`; `MOZ_LOG` sync; `taskset -c 0,1`;
    Xvnc + `DISPLAY`; debug build; forced delay; `MOZ_UPLOAD_DIR=$PWD/artifacts ... --profiler-save-only`. Score on
    `Passed:/Failed:/Todo:` totals; ≥6 runs before/after.
20. **State cause** (J). Leaker vs victim (name leaker), product vs test bug, test bug vs harness footgun.
21. **Fix** (J). Remove own `skip-if` in same commit; misleading failure message → separate commit; if
    unknown cause: `DEBUG - ` instrumentation commit (all at once).
22. **Verify locally** (M) re-run repro + `--verify` must pass.
23. **Commit** (M/J) `WIP - ...` or final per CM; `./mach lint --outgoing`, `./mach format --outgoing`.
24. **Write artifacts** (J): `artifacts/sessionlog.md` (state line `**State: <state>** — detail`),
    `artifacts/D-<shortname>.md` , bug drafts,
    `artifacts/<tool>-feedback.md`. One-line report to parent per state change.

### E. Review gate, integration, iteration
25. **Independent patch review** (J) per commit, by non-author subagent with CM skill → `artifacts/review-<date>.md`,
    one line back; then one whole-stack pass (messages + diffstat). Findings go back to author.
26. **Collect** (M): `git -C <integration> cherry-pick <sha>...`; rebase Patch B, drop lines owned by fixes.
27. **HUMAN: approve re-push** → steps 11–14 (`--no-artifact` once any C++/Rust).
28. **Wait** (M): `treeherder-cli <rev> --watch --notify` (job state only).
29. **Triage** (J-light, subagent): `fx-tests try <rev> --perma-only`, `--all-jobs` (reads passing jobs →
    passed-on-retry), `--limit 0 --profiles --task-ids`, `--config <substr>`, `--json`; confirm job
    completion before claiming pass; crashes `fx-tests crash <taskId> <minidumpId>`. Output: table per test ×
    config; hand partial results back to owning agent. Newly exposed failure ⇒ new investigation.
30. Repeat until each entry terminal; re-skip only for unreachable config or someone else's live work.
31. **Final verification push** (M after approval): `./mach try fuzzy --preset desktop-frontend --rebuild 10
    --no-artifact <folder>` plus `-q` for asan/msix/standalone if history shows them; mac separately at
    `--rebuild 3` (maybe `--chemspill-priority`, user permission only).

### F. Submission
32. **Preconditions** (M checks): all entries terminal; no `DEBUG -` commit; final push green with job state
    checked; `fx-tests skips --path <folder> --limit 0 --include-run-if` matched both ways to the log.
33. **Overview** (cheap agent): `overview.md` prompt regenerates `artifacts/overview.md` from child logs +
    `git log` SHAs (read-only).
34. **HUMAN: file bugs.** Meta bug `[meta] Fix the flakiness in <folder>` (task, keyword meta, blocks 2063593
    for mochitests), then one bug per root cause. `bug-filing` skill: `./mach file-info bugzilla-component
    <file>`, `python3 .claude/skills/bug-filing/file-bug.py 'product=' 'component=' 'bug_type=' 'short_desc='
    'comment=' ['blocked=']` opens prefilled `enter_bug.cgi`; user submits, returns number.
35. **Reviewer** (M+J): `./mach file-info reviewers <files>`; validate with `./mach file-info reviewer-groups`.
36. **Rebuild stack in review order** (M): `git checkout -b bugNNNNNNN-desc main`; cherry-pick run-if
    conversions, then never-reproduced un-skips, then fixes; `git commit --amend -F artifacts/msg-N.txt`
    (no interactive rebase; or `GIT_SEQUENCE_EDITOR` + `exec` per CLEANUP_COMMIT_MESSAGES). Branch flat name (moz-phab rejects detached HEAD).
37. **HUMAN: approve stack + run `moz-phab submit`** (never run by agents, not even `--help`).
38. **After submit** (M): record D-URLs in log; rename `D-<short>.md` → `D<rev>.md`; post investigation as bug
    comment; needinfo authors of reused WIP.

### G. Review comments and re-submission
39. **Read comments** (M): `mcp__moz__get_phabricator_revision`, then `python3 phab-suggestions.py D<rev>`
    (conduit + AJAX changeset endpoint for "suggest edit" text; `~/.arcrc` token).
40. **Address** (J): resume the authoring agent with only `Address the review comments in D<rev>.` (fresh agent
    gets `sessionlog.md` + `D<rev>.md`); user feedback passed verbatim. Keep `Differential Revision:` trailer and
    same reviewer; reviewer-written message used verbatim.
41. **Interdiff** (M): author writes before/after of the fix alone (shared parent) in its worktree + new SHA.
42. Re-run patch reviewer, overview agent → submit list with fresh SHAs → **HUMAN re-submits**.
43. Landing/reordering: undocumented; Firefox checkout has `stack-reorganize`/`stack-split-commit` skills.

## 2. Human checkpoints
- Before **every** try push (incl. re-pushes, mac pushes): show `--no-push` task list, rebuild count, rationale,
  annotation audit. `--chemspill-priority` only with explicit per-push permission.
- When someone else is active on the same failure (hand back or keep skip-if).
- Harness/platform footgun reported (fix now / bug later / ignore).
- When a bug must be filed (user submits form, supplies number).
- Before stack goes to Phabricator; `moz-phab submit` is the user's.
- Re-skip proposals; patch-split decisions.

## 3. Pain points and lessons (source)
**Context / cost**
- Sessions exceeded 1M tokens or compacted, losing configs, worktree ownership, user instructions (BD).
- Parent reads raw output anyway: two `fx-tests try --all-jobs` dumps (~700 jobs/push) read by parent (SKILLS_SUMMARY #8, skills.md). Rework is where delegation collapses: parent edits + re-runs tests itself (BD §8, measured 2026-08-11).
- Foreground worktree builds hit the 10-min tool timeout twice (SKILLS #16).
- `--debug` worktrees compiled for tens of minutes when debug+artifact takes ~2 min; an agent declined a C++ fix believing it could not verify it (SKILLS #3, evidence).

**State**
- `summary.md` reached ~900 lines, stale (all update triggers parent-side; "investigating" ×8 while 2 were done), a regex edit destroyed 4 entries, no history (gitignored) (SKILLS #2). BURNDOWN_STATUS_extensions.md: ~1,085 lines, became a log; useful: bounded "first thing to do" index, `[verified]`/`[relayed]` tags.
- Tests silently fell off the list (one because its jobs were still pending) (BD).
- Brief appended mid-session never reached running/resumed agents (SKILLS #11). 
- Fix-session summaries were diaries (358 lines), worktrees on detached HEADs; "ready" claimed 3× wrongly (FIX_SESSION_SUMMARY.md).

**Collisions on a shared host**
- `git stash` is repo-wide across worktrees: an agent popped another's diff (BD §6, SKILLS #11). 
- Two mochitests from one objdir silently swap test lists (`tests.json`); >3 concurrent runs → extension-install/http3Server/Marionette port races (BD §7, skills.md). Serialize per objdir or hidden `--testrun-manifest-file`.
- `profiler-cli` sessions machine-wide; bare `stop` killed sibling analysis (BD §7). Concurrent builds fail on shared `~/.mozbuild` (retry works). No teardown — one ~20 h session left 17 worktrees, 5 servers, an Xvnc, 21 GB objdir (skills.md).
- cwd drift: cherry-picks landed on the hub's detached HEAD; always `git -C <worktree>` (BD §3). 
- Worktrees nested inside the checkout break `mach try` path resolution (SKILLS #35). 

**Try pushes**
- Paths derived from the diff, not the failure list: 2 of 16 fixes unverifiable on a ~1,000-job push (SKILLS #33).
- Absence from failure list = "did not run" too: mac reported validated while 40 jobs pending (BD §4). `treeherder-cli` lists only failures; Treeherder failure lines miss tests (BD §4, FX_TESTS_FEEDBACK).
- Artifact stickiness: `mach try again`/artifact trees test central's binaries for C++ patches; "when in doubt `--no-artifact`" became always (BD §3, SKILLS #34).
- Presets exclude asan/standalone where flakiness lives (BD §3).  Mac pool queues 20+ h; Apple Silicon/15.30 browser-chrome unreachable without `--full` (BD §3).
- Private bug in commit msg → Lando rejected push; `SKIP_BMO_CHECK` is user's decision (skills.md). 14 manifests in one path → one chunk timed out, zero signal on a config all session (skills.md).
- `--profiles` under-reports existing per-test profiles; confirm via `artifact` markers (BD §4/§7, FX_TESTS_FEEDBACK ×6).  Failure may be in run 1, not run 0 (FX_TESTS_SUMMARY #3).
- Hard hangs are invisible to fx-tests (no `test_end`) (FX_TESTS_DEFERRED). Windows mixing pre/post fleet migration gave a stale 38% rate (skills.md).

**Investigation quality**
- Unverified cross-test claims in briefs were wrong 3/3 (BD §1); parent's own inference in fix briefs (BD §1); "won't reproduce here" was wrong every time — Windows/macOS-only failures reproduced locally (SKILLS #7).
- Forced-race control proved a path exists, not that it's taken; wrong-cause patch shipped (SKILLS #19). `--repeat` 0/20 vs fresh 4/15 (BD §7).  `--headless` gives false repros/negatives; Xvnc needed (BD §7, SKILLS_DEFERRED).
- Victim-side guards rejected in review; name the leaker (BD §5).  Misleading failure messages worth fixing (SKILLS #25).
- "infra" class used to close items without evidence; deleted (BD §2). Dead-condition errors: platform vs platform×suite; OR-masking; try graph ≠ CI graph (DEAD_MANIFEST_CONDITIONS).

**Review / submission**
- Commit messages were essays; every one rewritten (BD §9.3); avg 25 body lines vs 3–8 budget (FIX_SESSION_SUMMARY). Review gate without CM skill only adds text (SKILLS #30). 
- Wallpaper patches passed 17 reviews by filing a follow-up bug (SKILLS #14). One speculative aside cited 3× as independent evidence (SKILLS #15).
- Parent edits to an agent-owned commit message get reverted on its next amend (skills.md). Review subagents not started until prompted though 8 patches idle — review should trigger on "verified", not "before ready" (skills.md).
- First burndown stalled at a green stack: no record of commit→bug→reviewer (BD §9). `bug-filing` needs interactive browser; unusable from subagents → drafts to files (SKILLS #9). `find-reviewer` ranking wrong for shared files (SKILLS #36).
- Subagent harness refuses `Write` for `.md`; agents used heredocs (SKILLS_DEFERRED). 
- Phabricator interdiff folds in base changes; author writes its own interdiff (address-review-comments.md). 

## 4. Key data formats and rules

**Status file (old `summary.md`, BURNDOWN_SUMMARY_TEMPLATE)**: header (State: in progress | waiting on user |
waiting on try | ready to submit | submitted; `Tests: N — X done, Y open`; Verified; integration worktree;
dates) → Findings F1..Fn (Evidence / Covers / Not verified for / Refutes) → numbered Tests (header =
disposition; italic "Was:" line with bug/worktree or `[bug to file](enter_bug.cgi?...)`; Cause / Fix / Verified
bullets, ≤5) → Try pushes table (`# | Revision | What for | State waiting/complete/analysed | Findings`) → The job
(verbatim prompt + dated instructions) → Notes (decisions, ruled out, open questions, repro recipes, traps).
**New (OPF)**: per-worktree append-only `artifacts/sessionlog.md` with first line `**State: <state>** — <detail>`
(grep-able); parent's append-only log; `overview.md` generated (table Test|State; What needs the user;
Worktrees; Ready to submit [SHA, branch, bug, D link, interdiff]; Try pushes; Bugs to file).
States: `not started · investigating · cause identified · fix written · fix verified locally · in review by a
subagent · in try (push N) · blocked — <x> · waiting for review · addressing review comments ·` terminal ✅
`fixed, verified push N · left as-is — <mechanism> · handed back — bug N, <person> active`. Forbidden: "could not reproduce", "infra", "out of scope".
**DFP report** (`report-template.md`): state line + fields Kind (test bug · product bug · victim of X · harness footgun ·
too slow · environment · no longer fails · not determined), Confidence (shown · consistent · not determined), Fix layer/size,
Someone on it; sections Cause / profile observations (linked) / unexplained / what would settle it.

**Commit messages**: `Bug NNNNNNN - <imperative change>, r=<reviewer>.` (`r=` never `r?`, `#group`). Body 0–8 lines: defect, why this approach/file, blast radius,
bug that added a removed annotation. Cut: derivations, diff restatement, measurements, unproven mechanisms, try
links, `file:line`, cross-commit refs, hedging. No AI attribution.
Keep `Differential Revision:` on amend; keep reviewer. Pre-bug: `WIP - ...`; never-land: `DEBUG - ... DO NOT LAND.`
CLEANUP_COMMIT_MESSAGES.md has verification greps (automatable lint).

**Bugs**: one per root cause, not per test; reuse open unassigned bugs; meta bug per folder (blocks 2063593);
filed late (after green try); agents draft to `artifacts/` only; user submits `enter_bug.cgi`. Draft content:
symptom, repro, mechanism with source ref, ask; include `https://tests.firefox.dev/test.html?test=<path>`;
summary shape depends on type (defect=symptom).

**Try selection**: decide the question first — broad/no rebuild (did we break things) · folder-scoped
`--rebuild 5` (how flaky) · only failing jobs, rebuild sized to rate (does fix work; 10% → ~20 runs; max 20,
3 with `--full`). Configs from `fx-tests test` per-config table, not presets (keep asan, standalone, msix, swr,
a11y). Paths from failure list (every fixed failure's folder), file path needs `--allow-testfile-path`.
Union = repeated `-q` (fzf `|` binds to adjacent term only). Mac excluded while iterating; mac own push at
`--rebuild 3`; only Intel 10.15 browser-chrome in default graph. Artifact: no native changes on origin/main →
artifact; C++/Rust or autoland base → `--no-artifact` (artifact also disables PGO). Never `--rebuild` with
`--full`. Final: `--preset desktop-frontend --rebuild 10 --no-artifact` + debug. Pre-existing perma-fail rows
still need rate check.

## 5. Reusable helpers
- `/build/prompts/skills/orchestrate-parallel-fixes/new-worktree.sh` — worktree + mozconfig (debug/opt ×
  artifact/full) + build + mochitest smoke test; `--list`, `--remove`. Note item 35: worktrees inside the checkout
  break `mach try` test resolution — move them out.
- `/build/prompts/skills/read-phabricator-comments/phab-suggestions.py` — conduit client (`conduit()` with
  `~/.arcrc` token), inline comments with suggested-edit text; reusable for revision status polling.
- `/build/prompts/skills/diagnose-failures-from-profiles/profile-link.py` — profiler.firefox.com deep links from a
  profiler-cli session (thread encoding, ranges, `--check`).
- `.../available-gb.sh` — MemAvailable in GB (fleet sizing: (GB−2)/1.5 agents, ≤20).
- `.../archive-investigation.sh` — tar investigation dir + Claude transcripts (finds session by grepping
  `~/.claude/projects/*/*.jsonl`); useful for cost/observability.
- Session-state grep loop (SKILLS_SUMMARY item 2) over `artifacts/worktrees/*/artifacts/sessionlog.md`.
- bug-filing `file-bug.py` (builds enter_bug.cgi URL);
  `./mach file-info bugzilla-component|reviewers|reviewer-groups`.

- Directly callable: `fx-tests --json`, `treeherder-cli --watch`, Treeherder `/api/project/try/jobs/?push_id=N&count=2000`, Taskcluster queue, Bugzilla REST, conduit.
