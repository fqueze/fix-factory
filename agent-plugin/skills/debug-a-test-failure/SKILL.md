---
name: debug-a-test-failure
description: Investigate and fix a mochitest or xpcshell test failure.
---

# Debugging a test failure

Every step below is required. Skipping one means the parent or the user has to ask again.

`fx-tests` is the entry point for everything CI-side. If it is missing,
`npm install -g github:mozilla/aretestsfastyet`, then read `fx-tests guide` in full — it
documents traps that `--help` does not.

## 1. Gather information

**Get to a test name or path**, which is what `fx-tests` queries take. A bug is a starting
point, not an answer: read it for the test(s) it names, its comments, and any attached WIP
patch, which tells you what has already been ruled out. One bug may name several tests
failing in unrelated areas. Check `regressed_by` and the `regression` keyword — a sheriff
backfill may have bisected this for you already. Check the bug's product and repository too: a
trunk failure starred onto a bug for an unrelated product sends you hunting a changeset that
does not exist.

```sh
fx-tests test <path>               # how often and where it fails
fx-tests test <path> --executions  # did it pass on the harness retry?
fx-tests test <path> --coverage    # where it runs at all
fx-tests test <path> --history     # is this new?
```

Check for an existing bug before duplicating someone's work. You want to know whether the test
fails only in parallel, only in manifest order, or only on one platform.

If `--history` shows a step change rather than a background rate, look for what changed around
the first failing push — a landing, or the test machines.

**Then find a profile of the failure, and go to it with a question.** Your failure signature
suggests the question: "waited for X and X never came" can be a `NotifyObservers` question, a
wrong-value assertion a `SetNeedStyleFlush` one, a mis-aimed click a `DOMEvent` one (the
markers below). This is the step that decides whether the rest is quick:

- From a try push — `fx-tests try <rev> --profiles`.
- From an intermittent's failing CI tasks — list the job's artifacts and fetch the per-test
  profile from `.../artifacts/public/test_info/<name>`. (`fx-tests test` gives you
  resource-usage profiles, not per-test ones.)
- Locally — re-run with `./mach test --profiler-save-only <test>`.

Use the `profiler-analysis` skill to drive `profiler-cli`. Never `WebFetch` a
`share.firefox.dev` profile link. Taskcluster artifact URLs need `curl -L`.

Read two or three from the worst config plus a passing run to compare against — they mostly
say the same thing.

A CI profile without C++ frames still has **label frames**, which tell you which native path a
sample was in. Don't stop at samples. Alongside the obvious test-category markers, these are
the ones most often overlooked:

- **`DOMEvent`** — every DOM event dispatch, with type and latency.
- **`NotifyObservers`** — every observer notification, **with a stack**. Shows what arrived
  instead, when a test waits on a topic that never comes.
- **`SetNeedStyleFlush`** — every DOM change that dirties style, **with a stack**.

Go back to the profile to check each hypothesis, rather than adding logging and re-running: a
re-run of an intermittent is not guaranteed to reproduce anything. The profile shows what
happened: when it contradicts your hypothesis, the hypothesis is wrong.

## 2. Reproduce it

**"It only fails on mac in CI" is about rates, not mechanism** — the platform is usually a
multiplier on a race that exists everywhere. Re-open the question once you know the mechanism.

Cheapest first:

- **Run it once.** Then a few times.
- **Widen the race on purpose** — the strongest technique, and the first to reach for once the
  profile has told you which two paths race. Insert a delay in the one you believe wins: a
  test that never fails naturally will fail 20/20 with the delay and 0/20 with your fix and
  the delay still in. Works on any platform. Remove the instrumentation before you commit.
- **Force the condition the failing config has and yours does not** — a window geometry, a
  filesystem permission, a locale. A `chmod 000` directory reproduced a "macOS-only" failure
  on Linux.
- **A debug build** if the race looks native: assertions and slower timings often make an
  intermittent deterministic.
- **`MOZ_CHAOSMODE=0x7`** (thread, network, timer scheduling) is **not** a subset of
  `--verify`'s `0xfb`, which is everything *except* timer scheduling. If one finds nothing,
  try the other.
- **`MOZ_LOG` with `sync`** widens the race and records it at once. On debug builds, do not
  set `MOZ_LOG_FILE`: it steals the output the shutdown leak check parses, faking a failure.
- **`--verify`** (slow): 10 iterations in one browser, 5 runs each in a *fresh* browser, then
  both under `MOZ_CHAOSMODE=0xfb`.
- **`--repeat`** (slow) keeps one browser across iterations, so it is misleading for any race
  needing a fresh session — one reproduced 4/15 in fresh runs and 0/20 under `--repeat`. A
  clean `--repeat` is not evidence.
- On Linux, **`taskset -c 0,1`** emulates a saturated CI worker.

Instrumentation can hide a race as easily as widen it. If it goes quiet when you add logging,
consider logging into memory and printing later instead of doing I/O from the path you suspect.

For a failure that only appears in manifest order, run the suspect before it if the profile
named one, then bisect with `--start-at` / `--end-at`.
`--run-until-failure` is mochitest-only and caps at 30 runs unless `--repeat` raises it.

If reproduction is genuinely impossible, write the reason next to the mechanism and say
plainly that the fix is unverified.

## 3. Identify the issue, and state it

**Do not write a fix until you can state in one sentence what is wrong**, and until the
mechanism you name accounts for every symptom, not just the failing assertion. Three
distinctions decide what the fix may touch, and getting them wrong is how patches get
rejected:

**Leaker or victim.** A test failing only in manifest order is often the victim of state left
behind by an earlier test — a pref never popped, an observer still registered, a service left
mocked. A leaked animation or rAF loop leaves vsync enabled and fails everything after it; a
subtler leak may only break a test a few positions later. **Name the leaking test before
proposing any change.** A guard in the victim needs an explicit statement of why the leaker
cannot be fixed instead — otherwise it is a wallpaper patch and a reviewer will say so.

The job's `profile_resource-usage.json` is worth opening here: its `Test` spans are coloured
by whether the result matched expectations, so a run of consecutive failures is a visible
block, and the test at its head is your suspect.

**A test failing ~50% is *consistent with* order dependence, not proof of it** — the retry may
simply have won the race, and "passed on harness rerun" is an aggregate across jobs. A cheap
discriminator: check whether the `standalone` variant is among its failing configs, since that
variant restarts the browser between tests.

**Product bug or test bug.** A product bug gets fixed in the product, never wallpapered over
in the test. A test bug gets fixed in the test, never worked around in shipping code.

**Test bug or footgun.** If the test was not obviously wrong — if it fell into a trap the
harness, the platform or the test utilities set for it — say so in your report rather than
patching around it locally. The user decides whether to eliminate the footgun tree-wide.

## 4. Write the fix

Fix the cause you named in step 3, at the layer it belongs to. Keep the change minimal: a
reviewer should see the defect and the fix, not a cleanup pass. Minimal is not the smallest
diff that goes green — find every file the cause breaks before deciding the scope.

Fixing an intermittent without removing its own `skip-if` from the manifest is half a fix.

If you could not determine the cause, a debug-logging commit prefixed `DEBUG - ` is the
acceptable alternative. **Add all the instrumentation you will need at once** — each try round
is hours, so walk the possible outcomes and ask "if this comes back, do I know the answer?".
Say what question each piece answers.

**If the failure message misled you, fix the message too**, in its own commit — only the
message changes and the same cases fail, as in bug 2063565. It pays out for everyone who hits
that message next.

## 5. Verify it locally

Run whatever reproduced the failure in step 2, now with the fix. If the only reproduction was
a widened race, keep the widening in place while you verify. If the fix comes with a new test,
check that it fails against the unfixed build.

**Judge each run on its `Passed:`/`Failed:`/`Todo:` totals, not on grepping the log for the
failure.** A grep only says the failure you expected is absent; the totals also catch the ones
you did not. For an intermittent, no rate means no claim: at least 6 runs before and after.

**Then run `--verify` and require it to pass.** Regressing test-verify is unacceptable. The
one exception is a test already failing under `--verify` for an unrelated reason — say so
explicitly if you claim it.

## 6. Commit, and report

Commit message per `commit-message` — short; the narrative lives in the files below.

Report: root cause, or the specific remaining unknown. The evidence for it. Whether you
reproduced locally and how. Your commit SHA. Any footgun worth fixing tree-wide, and any tool
feedback you logged. **Distinguish what the data shows from what you are inferring.** Keep it
short — the files below exist so you need not retell them.

## Writing down progress as you go

Both files live under `artifacts/` and are written from the moment you understand the failure,
not at the end. Assume you can be stopped without warning.

### `artifacts/sessionlog.md` — state and handover

Append-only: write each state change as you reach it, and if you are working for a parent
agent, send it that line too.

Then the handover: what happened, hypotheses killed (so nobody re-runs them), try pushes and
results, commits and their revision ids, and **the session ids**, so a later session can grep
the logs for what this file does not carry. It exists so a fresh agent can answer review
comments without resuming yours.

### `artifacts/D-<shortname>.md` — for the user to read

Short enough to read in a minute, and written for a human, not an agent. Renamed to
`artifacts/D<revision>.md` once the patch is submitted.

```markdown
# <test> — <one line: what is wrong>

<Three lines: the defect and what the patch does about it.>

## How this was found
<One paragraph: the failure signature, what the profile showed, which test was the leaker
if it was an order dependency. If the patched test itself never failed, name the test that
did — otherwise the patch reads as editing a healthy test at random.>

## Alternatives considered
<A few lines: what else would have fixed it, and why not that.>

## Verified
<Precisely: forced-delay 20/20 → 0/20, `--verify` green, or push N green on these configs,
or "not verified". Link the relevant try pushes.>
```

## Tool feedback

`fx-tests` and `profiler-cli` are early, actively developed, and fixed based on this feedback.
When one costs you time or tokens, **append** to `artifacts/<tool>-feedback.md` — exact
command, expected, got, workaround — and say in your report that you logged something, so the
parent can aggregate it. Never rewrite an existing feedback file.

**Post-processing `--json` with a script is a missing feature: report it every time.**
