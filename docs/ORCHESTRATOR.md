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
- **Round limits:** lint violations go back to the author at most twice. A critical review gets at most 3 rounds with
  the author. After that, it comes to you.
- **Authors** are resumed in their own session.
- **When step 3 runs:** at whichever comes first, the push finishing or 2 h after it started, so slow pools don't
  hold everything up. It runs again when the push finishes, adding new groups.
- **Try failures** go to the patch that touches the failing test, or else a file in its folder. Anything else goes
  to Haiku, then to you.
- **Submission detected:** while a submit is waiting for you, `stack.ts import` runs every 2 min. Once every patch
  has a `Differential Revision:` trailer, the request moves to review comments.
- **Phabricator** is polled every 10 min.
- **Worktrees** start from `baseRef` (new config field, central-based), with an artifact build.
