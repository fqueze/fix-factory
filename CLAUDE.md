# fix-factory

An orchestrator and a web UI (port 4300) that run Claude agents to fix Firefox test failures, from a request to
patches on Phabricator. Node 24 + TypeScript, no frameworks, no dependencies beyond dev types.

## Layout

- `src/orchestrator/next.ts`: the planner. `next(state, ctx)` returns the events to append and the jobs to start;
  it is pure (no I/O), and runs again after every event.
- `src/orchestrator/handlers.ts`: what a finished job's output or report becomes (events).
  `commands.ts`: what your clicks in the UI (commands.jsonl) become. `main.ts`, `runner.ts`: the loop and the jobs.
- `src/state/fold.ts`: folds a request's events into its `RequestState`. `src/types.ts`: events, state, reports.
- `src/cli/*.ts`: the scripts jobs run (`stack.ts` assemble/rewrite/import/order, `try.ts`, `phab.ts`,
  `lint-text.ts`, `worktree.ts`…), each runnable by hand: `node src/cli/<x>.ts <subcommand> …`.
- `src/server/`: the web UI (`pages/request.ts` renders a request, `client.js` the page's script, `style.css`).
- `prompts/*.md` and `schemas/*.json`: each agent's prompt and its report's JSON schema.
  `docs/PROMPTS.md` is generated: run `node src/tools/prompts-doc.ts` after changing a prompt (a test checks it).
- `docs/`: `CONTRACTS.md` (conventions, state layout) and `ORCHESTRATOR.md` (the planner's rules) are references;
  `PROMPTS.md` is generated; `MVP.md`, `WORKFLOW.md`, `COMPONENTS.md`, `initial-prompt.md` and `research/` are the
  initial design (historical: the code went further and elsewhere).

## Working on it

- `npm test` (all tests), `npm run typecheck`. Commit only once both pass.
- The live factory (`npm run orchestrator`, `npm start`) runs **the working tree, uncommitted changes included**:
  `src/tools/supervise.ts` restarts both after a change, once the typecheck and the tests pass (a few minutes; a
  broken edit keeps the running version). Every edit goes live: check it on live data, not only in tests.
- Commits: one per change, its message a sentence saying what the factory now does. Fold fixes into the commit they
  fix rather than adding "fix" commits.
- Planner tests use the `Scenario` testkit (`src/orchestrator/testkit.ts`): `settle()` returns the keys of the jobs
  it starts, `complete(key, { output | report })` finishes one.

## State: /build/fix-factory-state

- `requests/<id>/events.jsonl`: append-only, the request's whole history. Never edit it; a repair appends events
  (the same `patch`, `user-done`… events the factory itself would write).
- `commands.jsonl`: commands from the UI. `POST /api/commands` with `command=<json>` sends one (what buttons do).
- `jobs/<job>/`: `plan.json` (what was started, with its input files), `spec.json`, `prompt.md`, `out.log`,
  `err.log`, `pid.json`, `exit.json`, `net.jsonl` (every network request it made; shown in the request's profile).
- `phab-client`: which client Conduit calls use (see Phabricator).
- To see what the planner would do now, offline: fold the request's events (`readEvents`, `foldEvents`,
  `buildView`) and call `next()` with `loadConfig("factory.config.json")`; keep such scripts in `artifacts/`
  (gitignored).

## Rules

- Agents have no try or Lando access (`src/agents/no-push.ts` refuses pushes): try pushes are planned by an agent,
  approved by the user, made by `try.ts`. The one exception: the user's `allow-push` lets one author session make
  one try push.
- The factory never runs `moz-phab submit`; the user copies the command (`mozPhabCommand` in the config, e.g.
  `my-phab`). Its only Phabricator write is setting a test plan, on the user's click.
- Phabricator: Conduit calls go through curl or Node's fetch, switching to the other on a 429 (`src/cli/phab.ts`):
  its CDN refuses one kind of client at a time. Polls read only revisions modified since the last one.
- Commit messages agents write never cite try pushes (they expire); evidence goes in reports and bugs.
- Bug drafts link a test's dashboard from its name, only when central shows the failure.

## Config: factory.config.json (gitignored)

`port`, `stateDir`, `firefoxRepo`, `worktreesDir`, `baseRef`, `claudeCommand` (e.g. `["mozsb", "claude"]`),
`mozPhabCommand`, `bugzillaEmail`, `maxAgents`, `maxBuilds`, `phabPollMinutes`, `phabPollHours`, `metaBugBlocks`,
`dryRun`, `maxWorktrees`, viewer and profiler settings (all commented in `FactoryConfig`, `src/types.ts`). A request's own config (`config-set` events) carries per-request options such as `tryWith`.

## Screenshots of the UI

Headless Firefox from a Firefox worktree's build, e.g.
`MOZ_HEADLESS=1 <obj-dir>/dist/bin/firefox --no-remote --profile <tmp> --screenshot out.png <url>`; measure layout
with a script injected into a saved copy of the page rather than by eye.
