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
- **Authors** are resumed in their own session. They never push: a hook refuses any push from an agent.
- **Follow-up bugs:** an author drafts one in `followUpBugs`: in address-review only for a reviewer comment that asks
  for it (by its id), in investigate-and-fix only with its fix and for an issue unrelated to the failure (else the
  report goes back). Each is a `follow-up-bug:<job>:<n>` ⚑ with the prefilled form, not assigned to you; the number you
  paste goes to the author, to reference where it said it would.
- **Try pushes** wait for your approval. A push you decline, with a reason, isn't made; the plan's others still
  wait for you. A stack's reviews and verification pushes are keyed
  by its code (git patch-id), not its commit ids: rewording a commit plans no new push. Pushes planned for code
  the stack no longer has, and not made, are withdrawn.
- **Try repro:** an author that can only reproduce on CI hands back a DEBUG commit that logs and widens the race
  ("needs a try repro"). Once the folder's other groups are settled, their DEBUG commits go on one branch and one
  push, planned like the others and approved by you. Once every push that carried them has finished (also after the stack was verified), each author is resumed with their results.
  - **A push of their own** (`debug-<h>-<n>`, planned by plan-try-pushes as `plan:debug:<h>`, approved by you): every
    waiting item's DEBUG commits in one push, when no push of the stack is coming to carry them (the request is past
    "verify on try"), or when you click Push now on a waiting item's row (`push-debug`). On top of what the failure was
    seen on (its task ids' pushes): the stack's branch for the stack's own pushes; the commits of the try push a
    try-push request was made from (imported with `import-push`, or the request's `tryWith` import); for a burndown's
    un-skip push, the stack (or central) with the skip-if removals; else central (its history, test-verify on
    central's code), with only them and the commits of `tryWith`. The push's purpose says what it's on top of. One at a time: a click while one is on its way is refused. Later stack pushes leave out
    DEBUG commits pushed on their own, until their author asks for another try repro. Declining it sends your reason
    to the authors.
- **When step 3 runs:** at whichever comes first, the push finishing or 2 h after it started, so slow pools don't
  hold everything up. It runs again when the push finishes, adding new groups. While a push or a run is pending,
  the request doesn't end for lack of items. A burndown's work list also has its folder's failures on central.
- **Try failures:**
  - **Matched:** a failure in a test that a patch touches, or that its group fixes, goes to that patch's author (not
    by folder: a burndown's patches share one). If the author says it isn't its patch's, it's triaged as unmatched.
  - **When:** once half the test tasks the push asked for have finished, or 2 h after it started; again when it ends.
  - **Unmatched:** Sonnet (`triage-try`) classifies each one, using its log and the test's history on central:
    - caused by a patch (a product change breaking another test) → that patch's author;
    - also failing on central → only noted on the page;
    - new and unexplained → a new work item;
    - infra → noted on the page. A retrigger is a push, so it needs your approval.
- **Approval before submission:** the moz-phab command is offered once you approved, in stack-viewer, every patch it
  would send; until then the submit step asks for that (a rebase keeps an approval: it is of the code and message).
- **Submission detected:** after you copy the moz-phab command, `stack.ts import` reads the branch every 20 s for
  10 min, then every 2 min for the rest of the hour, until what you submitted has its `Differential Revision:`
  trailers and the branch is settled. Once every patch has one, the request moves to review comments; patches
  submitted before that are reviewed, and reorganized on Phabricator, like the others.
- **Phabricator:**
  - **When:** polled every 10 min while you're present (`phabPollMinutes`), every 3 h while you're away
    (`phabPollHours`), and right away when you click "Check Phabricator now".
  - **Presence:** a visible page sends a `presence` command when it becomes visible or hidden, and every 15 min
    while visible. You count as away 30 min after the last
    `visible: true` (with several tabs, a hidden one sending `false` doesn't make you away).
- **Worktrees** start from `baseRef` (new config field, central-based), with an artifact build.
