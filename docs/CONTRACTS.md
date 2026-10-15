# Contracts between the factory's pieces

`src/types.ts` is the source of truth for events, commands, agent reports and config. This file covers the
conventions around it. For compatibility, **only add** fields, event types or commands. Never rename or remove one.

## Code

- Node 24, TypeScript run directly (type stripping). The `erasableSyntaxOnly` rule applies: no enums, namespaces or
  parameter properties. Imports use the `.ts` extension.
- No runtime dependencies without asking. Use `node:` modules: `node:http`, `node:test`, `node:util` `parseArgs`,
  `node:child_process`.
- Tests: `*.test.ts` next to the code, using `node:test` + `node:assert/strict`. Run with `npm test`, and
  `npm run typecheck` must pass.
- Shared helpers: `src/config.ts` (loads `factory.config.json`), `src/lib/exec.ts` (short commands),
  `src/lib/cli.ts` (CLI boilerplate).
- Module-specific types go in the module's own file, not in `src/types.ts`.

## State directory (`config.stateDir`)

```
commands.jsonl                    # every command, append-only
commands-data/<id>.<n>.txt        # long command strings; commands.jsonl holds {"textFile": ...} in their place
commands.cursor.json              # last command executed by the orchestrator
requests/<requestId>/events.jsonl # everything that happened to a request, append-only
requests/<requestId>/event-data/  # big event values; events.jsonl holds {"dataFile": ...} in their place
requests/<requestId>/data/        # inputs the orchestrator writes for agents and CLIs (groups, comments, edits)
requests/<requestId>/reports/<jobId>.json # each agent's validated report
jobs/<jobId>/spec.json            # {cmd, cwd, env, stdinFile?, kind, name, request, item}
jobs/<jobId>/prompt.md            # an agent's rendered prompt, its stdin
jobs/<jobId>/plan.json            # the orchestrator's plan for the job; retry-job runs it again
jobs/<jobId>/out.log              # stdout (a CLI's JSON, or claude's stream-json)
jobs/<jobId>/err.log
jobs/<jobId>/pid.json             # {pid, pidStartTime}, written when the job starts
jobs/<jobId>/exit.json            # {exitCode, endedAt}, written by the wrapper when the job ends
feedback/<target>.md              # agent feedback, one file per Feedback.target
cache/artifacts/<taskId>/...      # downloaded try logs and profiles
```

- One line per JSON object, written with a single `appendFileSync` call. Lines under 4 KB are atomic with
  `O_APPEND`. Big payloads go in a file, and the event only references that file.
- An event that would be over 4 KB has its biggest values (any field but `v`, `t`, `request`, `type`) moved,
  largest first until it fits, to `requests/<id>/event-data/<name>.json` (the value as JSON), replaced by
  `{"dataFile": "requests/<id>/event-data/<name>.json"}`. Readers replace every object that is exactly
  `{"dataFile": ...}` (with a path under that request's `event-data/`) by the file's content:
  `readEventsFrom` in `src/state/events.ts` does it.
- Files a job needs before it starts (an agent's `prompt.md`) are written into its directory by `startJob`.
- `job-started` events of the orchestrator's jobs carry `purpose` (`JobPurpose`): what the job is for, so a
  restarted orchestrator knows.
- `events.jsonl` is written only by the orchestrator. `commands.jsonl` is written by the web server and by the
  orchestrator (when it executes an approved recovery plan, it appends that plan's commands; when route-request says
  text from the main box is about an existing request, it appends a `tell-factory` for that request). Readers must ignore
  event types and fields they don't know.

## Jobs

- Every long-running thing is a job: agents, builds, test runs, try watchers, and any CLI call that can take more
  than a few seconds.
- The orchestrator writes `spec.json` and starts `node src/state/job-wrapper.ts <jobDir>` **detached**, in its own
  process group.
- The wrapper runs `cmd`, redirects stdout and stderr to the logs, and writes `exit.json` when the command ends.
- Restarting the orchestrator doesn't touch running jobs. On startup it re-attaches to them: pid plus
  `pidStartTime` from `/proc/<pid>/stat` decide whether a job is still alive.
- Job status is running, finished, lost (no process, no `exit.json`) or **orphaned** (the wrapper died but the command
  is still running). An orphaned job is cancelled before any retry, so two agents never share a worktree.

## CLIs (`src/cli/<tool>.ts`)

- `node src/cli/<tool>.ts <subcommand> [args] [--flags]`.
- **Output:** exactly one JSON document on stdout; `watch`-style subcommands print JSON lines instead. Logs go to
  stderr.
- **Exit codes:** 0 on success. 1 with `{"error": "..."}` on stdout on failure. 2 for usage errors.
- **`--dry-run`:** every subcommand with an external side effect (try push, Phabricator, Bugzilla writes, `git push`)
  refuses it under `--dry-run` and reports what it would have done. Read-only network calls are fine.
- Each CLI also exports its functions, so the orchestrator can call quick ones in-process. `main` runs only under
  `import.meta.main`.
- Subcommands, inputs and outputs are listed in `docs/COMPONENTS.md`. The module's header comment documents the
  exact JSON shapes.

## Agents

- `src/agents/run.ts` builds the command `config.claudeCommand + ["-p", "--output-format", "stream-json",
  "--verbose", "--session-id", id, "--model", model, "--json-schema", schema, "--settings", <2 h command limit>]` and runs it as a job in the item's
  worktree. The rendered prompt is written to `jobs/<jobId>/prompt.md` and passed as stdin (job spec `stdinFile`),
  because Linux limits one argument to 128 KiB. A follow-up uses `--resume <id>` in place of `--session-id`.
- **Result:** the last stream-json line, `type: "result"`, carries `structured_output` (the report),
  `total_cost_usd` (cumulative for the session: subtract the earlier runs' total to get one run's cost), `duration_ms`, `session_id`, `is_error`.
- **Transcripts:** `~/.claude/projects/<cwd with every non-alphanumeric character replaced by "-">/<sessionId>.jsonl`
  (very long names are shortened with a hash, which isn't handled yet).
- **Prompts:** `prompts/<name>.md`, with `{placeholders}` filled in by the orchestrator. Never inline a diff, a log or a
  list that can grow: pass a sha, a branch or a file path, and let the agent read what it needs.
- **Schemas:** `schemas/<name>.json` must match the report type in `src/types.ts`.
- **Feedback:** every report has `feedback: Feedback[]`. The runner appends each entry to
  `feedback/<target>.md`, with the job id.

## Side effects during development

Tests and development runs never push to try, never write to Phabricator or Bugzilla, and never start real agents.
Fixtures go in `test/fixtures/<module>/`. Capturing them with read-only calls (fx-tests, Treeherder,
`differential.revision.search`) is fine.
