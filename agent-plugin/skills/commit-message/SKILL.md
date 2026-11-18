---
name: commit-message
description: Write or clean up the commit message of a patch.
---

# Commit messages a reviewer can read

Write what the reviewer needs to decide **whether the patch is a good idea and acceptable**.
Not what you did, not what you noticed, not how you found it.

```
Bug NNNNNNN - <what the patch does, imperative>, r=reviewer.

<3-8 lines at most. Often omitted.>
```

Straightforward patches need no body. Apply the same test to any comment the patch adds —
the tic that writes four lines here writes them into the file too, where the reviewer has to
live with them.

## Keep

- The defect, in plain English.
- What the patch does, when the diff does not show it.
- **Why *this* approach**, where a reviewer would ask "why didn't you just...".
- **Why *this file***, when the patch edits something that looks healthy: a fix to a test
  that always passes, because it breaks a later test, is unreadable without naming that
  test.
- Blast radius, when a shared helper changes behaviour for unrelated tests.
- **Bug numbers a reviewer would otherwise dig for** — for an annotation you remove, the bug
  that added it. Two numbers beat a paragraph reconstructing the history.

## Cut

- **Derivations.** State the fact, not the reasoning that reached it.
- **Anything the diff shows** — files touched, conditions removed, which entries stay.
- **Anything a code comment already says.** Explain it at the call site or in the message,
  never both.
- **Measurements.** "fails 12/12", "20.7%", "38% of failures in this folder". Include a number
  only if a different number would lead to a different patch.
- **Mechanisms you have not proven.** Stated flatly, a hypothesis reads as established fact,
  and convincing prose about a wrong cause sends the next person down it.
- **Try push links** — they expire in a month; the commit is forever.
- **`file.cpp:359-363` citations** and narration ("That is what the failing test hits:").
- **Cross-references to other commits in the stack.**
- **Anything the patch does *not* do**: scope disclaimers, notes to your future self,
  hedging, counter-evidence you felt obliged to record. None of it changes whether the
  reviewer should approve the diff in front of them.

Everything cut that is still worth having belongs in a bug comment, or in your chat with
the user.

After cutting, check it didn't become factually wrong.

## Format

`Bug NNNNNNN - Description, r=reviewer.` Always `r=`, never `r?`. `#` prefix for a reviewer
group. No AI attribution lines.

When amending an already-submitted patch, keep its `Differential Revision:` trailer — that is
what makes it update the existing revision — and **leave the reviewer unchanged**. A group
review stays the group even when one member requested the changes.

Lint and format what you are committing — `./mach lint --outgoing` and
`./mach format --outgoing` — rather than leaving it for whoever assembles the stack.

## When it will not come out short

If the message keeps turning into a list of unrelated things, the patch probably needs
splitting. Do not split it yourself: report it and ask.

## When the reviewer writes it for you

Use their version verbatim, keeping the details they added. A third version re-opens the
round trip their draft was meant to end, and they know which facts are important.

**Never run `moz-phab`** — it publishes under the user's account and is theirs to run.
