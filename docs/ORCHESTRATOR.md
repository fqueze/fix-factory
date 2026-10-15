# Orchestrator

`node src/orchestrator/main.ts` runs the pipeline of `MVP.md`. It decides, and jobs do the work. Everything it
knows comes from the state files, so it can be restarted at any time.

## Loop

A tick runs on any change to `commands.jsonl` or a job file, and at least every 30 s:
1. Execute new commands.
2. Record the results of finished jobs. `try.ts watch` lines are read as they arrive.
3. For each request, the pure function `next(state)` returns the jobs to start. They start within the caps,
   review comments first.

**Restart:** orphaned jobs are cancelled and their step restarts. Lost jobs count as failures.

## Rules

- **Failures:**
  - A script is retried once. If it fails again, it's blocked and shows the error to you.
  - An agent report that doesn't match its schema gets one retry with the errors, then fails the same way.
- **Round limits:** lint violations go back to the author at most twice. A critical review with must-fix findings sends all
  its findings back, for at most 3 rounds; one with only nits gets a single author pass, then only the lint again,
  and isn't a round. After that, it comes to you.
- **Authors** are resumed in their own session.
- **When step 3 runs:** at whichever comes first, the push finishing or 2 h after it started, so slow pools don't
  hold everything up. It runs again when the push finishes, adding new groups.
- **Try failures:**
  - **Matched:** a failure in a test that a patch touches, or in that patch's folder, goes to that patch's author.
  - **Unmatched:** Haiku (`triage-try`) classifies each one, using its log and the test's history on central:
    - caused by a patch (a product change breaking another test) → that patch's author;
    - also failing on central → only noted on the page;
    - new and unexplained → a new work item;
    - infra → noted on the page. A retrigger is a push, so it needs your approval.
- **Submission detected:** while a submit is waiting for you, `stack.ts import` runs every 2 min. Once every patch
  has a `Differential Revision:` trailer, the request moves to review comments.
- **Phabricator:**
  - **When:** polled every 3 h, and only while you're present.
  - **Presence:** a visible page sends a `presence` command when it becomes visible or hidden, and every 15 min
    while visible. You count as away 30 min after the last
    `visible: true` (with several tabs, a hidden one sending `false` doesn't make you away).
  - **Coming back:** when you return and the last poll is more than 1 h old, it polls right away.
- **Worktrees** start from `baseRef` (new config field, central-based), with an artifact build.
