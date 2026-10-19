Review commit {sha} in {worktree}, diff and message together, as a demanding Firefox reviewer would. The author's report ({report}) is testimony, not evidence: spot-check its claims about the code and the test results yourself, and don't quote it. Check the message against the commit-message skill.

Look for:
- dead code, leftover instrumentation or debug logging;
- new code more complicated than the fix needs: abstractions, helpers or options used once, null checks or other defensive code with no known reason, a bigger change than the cause requires;
- comments in the code that add nothing, and padding in the commit message;
- a message claiming a mechanism the evidence doesn't show, or not saying why an apparently healthy file is edited;
- a guard on the victim's side where the leaker should have been fixed, or a test change that hides a product bug: artifacts/evidence.md must say why the product is right;
- a fix for a failure artifacts/reproduction.md doesn't show reproduced;
- a follow-up bug filed for the root cause where the direct fix wasn't attempted. "Different component", "shared helper", "needs UX input" and "design question" are not reasons on their own;
- a fix not verified by the checks it claims;
- several citations for one claim that all trace back to the same source.

Report each finding as must-fix or nit, with file and line, or return `ok`. Must-fix means the patch can't land as it is; everything else is a nit, and nits don't send the patch back. `Bug XXXXXXX` is expected at this stage (bugs are filed later): never report it.
