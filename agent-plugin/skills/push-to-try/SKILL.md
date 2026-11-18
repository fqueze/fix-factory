---
name: push-to-try
description: Choose which jobs a try push should run to verify a test fix without wasting CI.
---

**Decide what the push has to answer before choosing anything.** The three cases want
different pushes, and using the wrong shape either wastes CI or produces a result that cannot
support the claim you want to make.

| The question | The push |
|---|---|
| Did a harness or product change break anything? | Broad: many job kinds, many platforms, no `--rebuild` |
| How flaky is this folder, really? | Scoped to the folder, `--rebuild 5` |
| Does this fix work? | Only the job(s) that showed the failure, `--rebuild` matched to the observed rate |

For the last one, size `--rebuild` against the rate: a 10% intermittent needs ~20 runs to show
up several times; at 50% a handful will do, so spend the rest on more configs. Max 20, and
capped at 3 with `--full`.

A failure that reproduced only once in a push gives you nothing to measure a fix against.

## Which configs, which paths

Derive them from where the failure actually happened, per `fx-tests test <path>`'s per-config
table — not from a preset. Presets exclude unusual configurations, and that is where flakiness
lives: if the failure was seen on `windows11-64-25h2-asan/opt`, a push without asan cannot
reproduce it.

Derive the paths from the failure list too, not from the diff: **every failure you are fixing
must have its own test folder in the push.** A product-bug fix may touch none of them.

Two worth keeping in mind:

- **`standalone`** restarts the browser between tests, so it answers "does this pass in
  isolation?" for free.
- **Debug builds** assert where opt silently tolerates.

## Query syntax

`-q` takes an fzf query: spaces mean AND, and `|` binds only to adjacent terms — so
`"!swr | 'linux"` means "exclude swr, except on linux", rarely what was meant. **For a union
of config groups, pass `-q` repeatedly:**

```sh
./mach try fuzzy -q "'browser-chrome 'linux" -q "'browser-chrome 'windows 'asan" \
                 --rebuild 5 --no-artifact --no-push <folder>
```

The positional path becomes `MOZHARNESS_TEST_PATHS`. A *file* path is silently rewritten to
its parent directory unless you pass `--allow-testfile-path`.

## Dry run first, every time

Run with `--no-push`, read the task list, and **show it to the user before spending CI** —
every push, not just the first.

Keep each command in `artifacts/try-command-N.sh`, so "the same query" next round is a fact.

## Artifact builds

From an artifact-mode tree the push is artifact too, and omitting `--artifact` does not change
that; you have to pass `--no-artifact`. **If any patch touches C++ or Rust, an artifact push
builds none of it and tests trunk's binaries** — meaningless, and nothing warns you.
`./mach try again` replays that setting too. Check the diff for native files rather than
skipping the question: on top of `origin/main` with none, use an artifact build. On an
autoland base, use `--no-artifact` — it can carry someone else's C++ changes.

## A constrained pool

When jobs are queueing long enough to stall the loop, a `--chemspill-priority` push is an
option — small, folder-scoped, and **only with the user's permission**. Permission granted
once is for that push, not for the session.

## Reading the results

```sh
fx-tests try <rev> --perma-only    # the highest-signal section
fx-tests try <rev> --all-jobs      # also reads jobs that PASSED, so a test that failed and
                                   # then passed on retry surfaces. Slower, and what you want
                                   # when the question is flakiness.
fx-tests try <rev> --limit 0 [--profiles --task-ids]
```

`fx-tests` is required for this; install it if missing
(`npm install -g github:mozilla/aretestsfastyet`). **For mochitest and xpcshell results, never
read failures out of `treeherder-cli`** — use it only to see whether jobs are still running.

**Absence from the failure list means "did not fail", which includes "did not run".** To know
whether a given job actually ran a given test, read that job's `profile_resource-usage.json`
with `profiler-cli`: it has a `Test` span per test that ran.

A perma-fail row marked **Pre-existing** also fails on trunk — but read the rate rather than
dismissing the row. Turning a 5% intermittent into a perma-fail is still your patch, and still
blocks the stack.
