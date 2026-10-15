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
requests/<requestId>/events.jsonl # everything that happened to a request, append-only
jobs/<jobId>/spec.json            # {cmd, cwd, env, kind, name, request, item}
jobs/<jobId>/out.log              # stdout (a CLI's JSON, or claude's stream-json)
jobs/<jobId>/err.log
jobs/<jobId>/exit.json            # {exitCode, endedAt}, written by the wrapper when the job ends
feedback/<target>.md              # agent feedback, one file per Feedback.target
cache/artifacts/<taskId>/...      # downloaded try logs and profiles
```

- One line per JSON object, written with a single `appendFileSync` call. Lines under 4 KB are atomic with
  `O_APPEND`. Big payloads go in a file, and the event only references that file.
- `events.jsonl` is written only by the orchestrator. `commands.jsonl` is written by the web server and by the
  orchestrator (when it executes an approved recovery plan, it appends that plan's commands). Readers must ignore
  event types and fields they don't know.

## Jobs

- Every long-running thing is a job: agents, builds, test runs, try watchers, and any CLI call that can take more
  than a few seconds.
- The orchestrator writes `spec.json` and starts `node src/state/job-wrapper.ts <jobDir>` **detached**, in its own
  process group.
- The wrapper runs `cmd`, redirects stdout and stderr to the logs, and writes `exit.json` when the command ends.
- Restarting the orchestrator doesn't touch running jobs. On startup it re-attaches to them: pid plus
  `pidStartTime` from `/proc/<pid>/stat` decide whether a job is still alive.

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

- `src/agents/run.ts` builds the command `config.claudeCommand + ["-p", prompt, "--output-format", "stream-json",
  "--verbose", "--session-id", id, "--model", model, "--json-schema", schema]` with stdin from `/dev/null`, and runs
  it as a job in the item's worktree. A follow-up uses `--resume <id>` in place of `--session-id`.
- **Result:** the last stream-json line, `type: "result"`, carries `structured_output` (the report),
  `total_cost_usd` (cumulative for the session: subtract the earlier runs' total to get one run's cost), `duration_ms`, `session_id`, `is_error`.
- **Transcripts:** `~/.claude/projects/<cwd with every non-alphanumeric character replaced by "-">/<sessionId>.jsonl`
  (very long names are shortened with a hash, which isn't handled yet).
- **Prompts:** `prompts/<name>.md`, with `{placeholders}` filled in by the orchestrator.
- **Schemas:** `schemas/<name>.json` must match the report type in `src/types.ts`.
- **Feedback:** every report has `feedback: Feedback[]`. The runner appends each entry to
  `feedback/<target>.md`, with the job id.

## Side effects during development

Tests and development runs never push to try, never write to Phabricator or Bugzilla, and never start real agents.
Fixtures go in `test/fixtures/<module>/`. Capturing them with read-only calls (fx-tests, Treeherder,
`differential.revision.search`) is fine.
