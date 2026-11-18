# Investigating and fixing a test failure

Scope:
- A file the request points at (a triage of these failures, say) is read before anything else: what it found about your test stands unless your own evidence shows otherwise.
- A failure the request doesn't ask to fix (its scope, its constraints) isn't fixed: report "left as-is", saying why.
- Use "handed back" only when someone else is actively working on it.

Evidence, in this order:
- The failing CI tasks' profiles (the test's `profile_<test>.json.gz` artifact) come first: read them with profiler-cli before the logs, the code and anything else from CI, and list what each shows in `profiles`. Load each from its artifact URL (`https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/<taskId>/artifacts/public/test_info/<file>`), not a downloaded copy, and give each finding the `permalinks` of the markers that show it (`profiler-cli marker info <m> --permalink`, with its thread selected): a reviewer opens them from the test plan.
- Then reproduce the failure locally, before changing anything. One that only shows on a platform you don't have counts as reproduced if the factory's un-skip try push shows it. If you can't reproduce it, stop with state "not reproduced" and say what you tried.
- There is no display by default. For a test that can't run under --headless (screen sharing, drag and drop, native events, focus), start one the size CI's is, `Xvnc :<N> -geometry 1600x1200 -depth 24 -SecurityTypes None &` with an N not in `ls /tmp/.X11-unix`, run the tests with `DISPLAY=:<N>` and without --headless, and stop it when you're done.

The fix:
- When the test exposes a product bug (a leak, a race), fix the product: a test-side wait or guard that hides it is not a fix.
- A test that has to wait waits for the event, promise or mutation that says the thing happened. Polling (`waitForCondition` and the like, timers) hides the race behind a timeout: only in a test that already waits that way, or with a brief comment saying nothing better can be waited for. A wait for animation frames says in a comment what it waits for (typically the tested code itself waiting for a frame).
- Every wait or ordering change says why, in the code or the commit message, in words a reviewer understands without your investigation.
- One commit per fix, its skip-if removals included. Never keep or narrow a skip-if without the try failure and profile showing it still fails, and why that failure isn't fixed.
- Commit with a message following the commit-message skill, its `r=` from the find-reviewer skill, and `Bug XXXXXXX` if the fix needs a bug of its own. The commits of one failure's fix share one bug: a commit added later for the same failure uses the bug its first commit already has (often the test's intermittent tracking bug), never a new one beside it.

Try:
- Never push to try yourself (add --no-push to any mach try), and don't ask for a push of your own: the whole stack goes to try together. `tryRequest` is only for a push the user asked you for in a message. When your fix needs a platform you don't have, say so in `verification`: the stack's push checks it.
- When it only fails on CI and the profiles can't show what you need: first search every thread's markers for what's missing (their payloads, IPC ones included), and say in `profileGap` what the profiles show, what exactly they lack, and how you searched. Then commit what gets it, and stop with state "needs a try repro": the factory pushes your commits with the stack once the user approves, and resumes you with the results.
  - When what's missing would help with other failures too (a message's text, a decision the code makes, a state it doesn't record), add a profiler marker to the code: a patch of its own, not titled DEBUG, with its own bug draft, which stays to land.
  - Otherwise, a "DEBUG -" commit that logs what's missing, and widens the race when you know which it is.

Builds and runs:
- Your worktree has an artifact build. When you change native code (C++, Rust) and need to run it, don't build yourself: commit what you have and stop with state "needs a build" and `build` "opt" or "debug" (debug for assertions and leak checks). The factory moves your worktree, at the same path, onto a tree with that build compiled, and resumes you.

Files:
- Write <notes>/evidence.md (what shows the cause, and why the fix belongs where it is) and <notes>/reproduction.md (how to reproduce it, how often it failed with and without the fix), plus <notes>/reproduction.diff if you widened the race.
- <notes> is this item's own folder (create it): it outlives your worktree, which may go to another item while this one waits. Your worktree's artifacts/ is for scratch and big files (logs, profiles), which don't go in <notes>.

End with the JSON report: state, cause, the kinds of evidence (a guess from reading code says so), the reproduction, those files' full paths, how you verified the fix, a bug draft for each commit that needs a bug of its own (separate fixes, separate bugs; bug-filing skill; its test's dashboard linked from the test's name where the description names it, only when central shows the failure, never as a line of its own), and any patch yours must land after.
