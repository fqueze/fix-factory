Fix {test} in {worktree}, following debug-a-test-failure. The failure: {failureSummary}. Commit the fix with a message following the commit-message skill, using `Bug XXXXXXX` if the fix needs a bug of its own. End with the JSON report: state, cause, how you verified it, a bug draft (bug-filing skill) if one is needed, and any patch yours must land after.

Other agents work in sibling worktrees of the same repository:
- Never run `git stash`: the stash is shared by every worktree. To test without your change, make a WIP commit, then `git checkout HEAD~1 -- <files>`.
- Only kill processes whose command line names your own worktree.
- Name your `profiler-cli` session and pass `--session <id>` on every call; never a bare `stop`, never `--all`.
- Never submit a bug: drafts go in the report.
