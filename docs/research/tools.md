# Existing tools to reuse in the fix factory

**Sources.** `/home/florian/buildgit/*` is not reachable from this sandbox, and `gh` is not installed. The repos are public on GitHub as `fqueze/claude-profiler` and `fqueze/md-viewer`. claude-dashboard is not published (it pulls in claude-profiler with `github:fqueze/claude-profiler`). On npm, the name `claude-profiler` belongs to an unrelated package (Softjey); don't use it. Everything below was rebuilt from the Claude Code transcripts in `~/.claude/projects/-home-florian-buildgit-*`. On the host, `claude-profiler` is installed globally as an npm link to `~/buildgit/claude-profiler`.

## 1. claude-profiler

- **Purpose.** Turns a Claude Code session transcript into a Firefox Profiler profile. Each agent is a track: the main conversation, plus one process per subagent, ordered by start time. Markers cover model calls (model, stop reason), tool uses and user turns. Counters show "Agent Cost" and "Total Cost" (summed over all agents) over time. `--size` builds a different profile: what filled the context window, at the peak or the last call.
- **Stack.** Plain Node, CommonJS, nearly no dependencies. Files: `index.js` (CLI and core), `session-index.js`, `context-size.js`, `size-profile.js`, `transcript.js`, `remote.js` (ssh), `JSONL_FORMAT.md` (documents the transcript format and the price table).
- **CLI.**
  - `claude-profiler` with no argument starts a local page listing every session under `~/.claude/projects/`. It has a "size" checkbox.
  - `claude-profiler <session>.jsonl` starts a one-shot HTTP server (the profile is sent with `Access-Control-Allow-Origin` for the profiler origin) and opens `<origin>/from-url/<encoded url>?thread=0`. `thread=0` stops the front end from reordering tracks.
  - `claude-profiler <sshhost>` (or `--host`) profiles sessions on a remote machine. Internally it uses `--json probe|list|stamp <id>|profile <id>`.
  - Options: `--size`, `--at peak|last`, `--profiler-origin <url>`.
  - Environment: `PROFILER_ORIGIN` (e.g. `http://localhost:4242`), `CLAUDE_CONFIG_DIR` (where `.claude` lives), `CLAUDE_PROFILER_MODEL='old=new[,..]'` (renames a model, for both prices and markers).
- **Library API** (exported, and `main()` only runs under `require.main === module`):
  - `readJsonlFile(path)`
  - `readSubagents(sessionFilePath)`
  - `readSubagentsForSession(sessionId)`
  - `createFirefoxProfile(entries, subagents?)`: when `subagents` is omitted, they are looked up from the session id; pass `[]` to opt out.
  - `createSizeProfile(...)`
  - It also has a price table and `getPricingForModel`/`calculateCost`, but these are internal.
- **Outputs.** Profile JSON in processed format (`meta.version` 27, preprocessed 47).
- **Comments.** None.
- **How claude-dashboard already uses it** (Express server, port 3456):
  - `GET /api/session/:id/profile` returns `createFirefoxProfile(readJsonlFile(path))` with a CORS header.
  - The UI links to `http://localhost:4242/from-url/<encodeURIComponent(apiUrl)>?thread=0`. Browsers block profiler.firefox.com from fetching localhost, so the user runs a local front end with `yarn start` on port 4242.
  - The modules are required lazily, so claude-profiler code changes show up without restarting the server.
- **Recommendation.**
  - Use it as a library: `"claude-profiler": "github:fqueze/claude-profiler"`, or `file:../claude-profiler` on this machine.
  - Copy the dashboard's `/api/session/:id/profile` route.
  - Add a "Profile" button on each task row that opens the 4242 (configurable) from-url link with `?thread=0`.
  - Also link `?size` to a `createSizeProfile` route, to debug context bloat.
  - Don't embed it in an iframe; open a new tab.

## 2. md-viewer / diff-viewer / stack-viewer (`fqueze/md-viewer`)

- **Purpose.**
  - `md-viewer file.md`: renders Markdown live with reload on save. It exits when the tab closes.
  - `diff-viewer [file.diff]` (or stdin): a single diff as a review page.
  - `stack-viewer <revset>`: a series of commits in one tab. A list on the left shows them oldest first (change id or sha, subject, +/- counts) and each commit is a diff-viewer page in a same-origin iframe. Alt+Up/Down moves between commits, Alt+L hides the list, `#n` in the URL keeps the current commit. Side-by-side or unified diffs, patience diff, Bugzilla links, sticky headers.
- **Stack.** Node 20.11 or newer, ESM, no framework. `lib/diff.js` (`renderDiff`), `lib/diff-page.js` (`buildDiffPage`), `lib/stack.js`, `lib/stack-page.js`, `lib/serve-once.js`, `lib/git.js`, plus `assets/{review,diff,stack}.js` and css. `./install.sh` symlinks the three commands into `~/.local/bin`.
- **stack-viewer CLI.**

  ```
  stack-viewer [options] <revset>      # git: origin/main..HEAD, HEAD ; jj: lqs::tvz, 'trunk()..@'
    -R, --repo <dir>   repo (default: around cwd; a colocated jj repo reads the arg as a revset)
    -o, --output <f>   write a standalone HTML file instead of serving
    -p, --port <n>     fixed port (default: random free port on 127.0.0.1)
        --no-open      print the URL instead of launching a browser
        --max-commits N  default 100; above it, fails fast and suggests origin/main..HEAD
  ```

  Patches are always read with `git show`. The server is one-shot: it exits shortly after the page loads, but the tab keeps working because everything is inlined. A random port means the URL is only known from stdout.
- **Comments.**
  - Click a line or selection to comment. Comments live only in the page's JS state; nothing is saved on disk or sent to a server. The `mdv-review-change` event updates the per-commit counters.
  - The "Copy review" pill (per commit) and "Copy all reviews" (whole stack) put an agent-ready prompt on the clipboard: `Please address these review comments on commit <sha> (<subject>):` (stack form: `...on the following commits:` with one heading per commit), followed by entries like `- file:line — "quoted text"\n  comment`.
  - The embedding hook `window.mdvReviewComments()` returns a page's comments array, and saves a comment that is still being typed first.
- **Recommendation.**
  - Easiest path: a "Review stack" button runs `stack-viewer -R <worktree> -o artifacts/stack-<task>.html <base>..<head>` and serves or opens that static file in a new tab.
  - For quick comments that go back into the factory, serve that HTML from the dashboard origin and inject a small "Send to agent" button. It calls `frame.contentWindow.mdvReviewComments()` for each commit iframe (same origin), or simply reads the copied prompt text, then POSTs it to `/api/task/:id/review`. The orchestrator resumes the agent's session (`claude -p --resume <sid> "<review prompt>"`). The prompt format is already what agents receive.
  - Importing `lib/stack-page.js` directly avoids spawning a process, but the API is internal and unversioned. Prefer the CLI with `-o`.

## 3. claude-dashboard (`~/buildgit/claude-dashboard`, unpublished)

- **What it is.** Express `server.js` on port 3456 (`npm start`), a session browser over `~/.claude/projects`.
- **Rows.** One per session, with download, profiler and raw buttons. The raw button is `GET /api/session/:id/raw`, which serves the `.jsonl` for Firefox's JSON viewer.
- **Session view.** Expandable tool output with truncation; URLs in it (e.g. Bugzilla) are clickable.
- **Notes.** Per-session notes (`POST /api/session/:id/notes`).
- **Reuse.** Copy patterns rather than depend on it: `findSessionFile(id)`, the profile, raw and notes routes, and the tool-output renderer.

## 4. Cost and duration data per agent run

- **Transcripts.**
  - Main session: `~/.claude/projects/<cwd with / replaced by ->/<sessionId>.jsonl`, or under `$CLAUDE_CONFIG_DIR`.
  - Subagents: `<sessionId>/subagents/agent-<id>.jsonl` plus `.meta.json`.
  - Each assistant entry has `timestamp`, `message.model`, `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, with 5m/1h split), `sessionId`, `uuid`/`parentUuid`.
  - Wall-clock duration is the last timestamp minus the first.
  - For per-model cost, apply claude-profiler's price table (cache writes are priced by lifetime). The simplest exact way is to call `createFirefoxProfile` and read the final Total Cost counter, or reuse its pricing code.
- **`<sessionId>.cost.jsonl`.**
  - Lines look like `{"t":ISO,"c":cumulativeUSD}`. They are written by the user's status line (`foxtail --color always --log-cost`, from `~/.claude/settings.json`) out of Claude Code's own `cost.total_cost_usd`.
  - The last line is the session's total.
  - Interactive only: headless `-p` runs don't render a status line, so these files won't exist for factory runs.
- **Headless runs.** The final `result` event reports `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `usage`, a per-model `modelUsage` and `session_id`. Store these per task. They include subagents.

## 5. Launching agents headlessly from Node (Claude Code 2.1.280)

```
claude -p "<prompt>" --output-format stream-json --verbose \
  --session-id <uuid> --model opus|sonnet|fable|<full id> [--effort low..max] \
  --permission-mode bypassPermissions|acceptEdits|dontAsk  (or --dangerously-skip-permissions) \
  --allowedTools ... --disallowedTools ... --add-dir <dir> --append-system-prompt "..." \
  --max-budget-usd 5 --fallback-model sonnet -n "<task name>"
```

- **Process.** `spawn` it with `cwd` set to the task's worktree. Read stdout line by line: each line is a JSON event (`system/init` carries `session_id`, model and tools; then `assistant`/`user` messages; then the final `result`).
- **Session id.** Pre-generate it with `--session-id` (crypto.randomUUID) so the dashboard can link the transcript path and profile immediately.
- **Follow-ups.** `--resume <sid>` (optionally `--fork-session`) for review rounds.
- **Long-lived control.** `--input-format stream-json` keeps an agent open and fed over stdin. `--include-partial-messages` streams tokens live. `--no-session-persistence` would break profiling, so don't use it.
- **Agent SDK.** `@anthropic-ai/claude-agent-sdk` (`query({prompt, options:{cwd, model, resume, permissionMode, allowedTools, maxBudgetUsd}})`) yields the same messages as an async iterator. It is nicer typed, but the CLI works fine and mirrors what the user runs.
- **Worktrees.** `-w/--worktree` exists, but the factory should manage its own worktrees.
- **Transcripts.** Headless runs still write the normal JSONL, so claude-profiler works on them unchanged.
