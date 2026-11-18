# Working in a worktree beside other agents

Run builds and tests in the foreground and wait for them: your session ends when you stop, and anything still running in the background is lost.

Other agents work in sibling worktrees of the same repository:
- Never run `git stash`: the stash is shared by every worktree. To test without your change, make a WIP commit, then `git checkout HEAD~1 -- <files>`.
- Only commit to your own branch: never move another branch (`git update-ref`, `git branch -f`, a rebase), the stack's included. The factory rewrites the stack from your commits.
- Only kill processes whose command line names your own worktree.
- Name your `profiler-cli` session and pass `--session <id>` on every call; never a bare `stop`, never `--all`.
- If a tool can't read its input (profiler-cli refusing a profile's version, say), stop: report the state "blocked" with the error, and say it in feedback. Never work around it with your own parsing scripts or another copy of the tool.
- Never submit a bug: drafts go in the report.
