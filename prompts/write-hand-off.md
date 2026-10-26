The user is taking over some work groups of the factory's request {id} in a Claude Code session of their own, in the Firefox checkout {firefoxRepo}. Everything the factory knows about them is in {referencesFile}: the groups' failures, their latest investigation, their patches (and where their commits are kept if their worktree was removed), every agent session that worked on them with its transcript and JSON report, and the request's try pushes with their Treeherder links and triage. Read it, and as much of the reports and transcripts as you need to tell what was tried, what was found, and where it stands.

Write the prompt the user pastes into that new session, in Markdown, starting with what the task is in one or two sentences. Then:
- where it stands: what is understood of the cause, what each patch does, and how confident the evidence is, with what is still unproven;
- what was tried and dropped, and why, in a few lines, so the new session doesn't redo it;
- the try pushes that matter, each by its Treeherder link with what it showed in one line;
- the WIP: each worktree's path and branch with its commits (or, if it's gone, `git log` of its kept refs), and the bug numbers;
- the material to read: the session ids with their transcript paths, the reports, and the kept artifacts (profiles, logs, notes), one line each on what is in it.

Facts only, as specific as the references allow (function names, markers, failure rates); no guesses presented as findings. Nothing about the factory's own workflow (JSON reports, stacks, flags): the new session works for the user directly.
