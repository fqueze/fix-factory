# fix-factory

Orchestrator and web dashboard for producing, verifying and landing Firefox test-fix patches with Claude agents.

## Install

You need:
- Linux, Node 24 or later, git, and yarn (through corepack, which comes with Node).
- A Firefox checkout set up with `./mach bootstrap`. That also installs moz-phab and searchfox-cli.
- Claude Code, logged in. Agents run it through `claudeCommand`, ideally in a sandbox wrapper (`["mozsb", "claude"]`)
  so they can't read your credentials or push anything themselves.
- To submit patches and push to try (the factory does both, only after you approve): a Phabricator token in
  `~/.arcrc` (`moz-phab install-certificate`) and a Lando login for `./mach try` (run one try push by hand once).
- Disk: each agent's worktree is about 6 GB. The factory stops creating them below 20 GB free.

Then:

```
git clone https://github.com/fqueze/fix-factory.git && cd fix-factory
npm install
cp factory.config.example.json factory.config.json
```

Edit `factory.config.json`:
- `firefoxRepo`: your Firefox checkout. `worktreesDir`: where agents' worktrees go, outside that checkout.
- `stateDir`: where the factory keeps its state and its own tools, outside this repository.
- `bugzillaEmail`: the bugs the factory drafts are assigned to you.
- `allowedHosts`: other names you open the page with (e.g. a Tailscale machine name).
- `dryRun`: `true` refuses every external side effect (agents, try, Phabricator). Set it to `false` once the page
  looks right.

The other fields are explained in `FactoryConfig` in [src/types.ts](src/types.ts).

```
npm run tools          # optional: the factory fetches and builds its tools before each request anyway
npm start              # the page, on http://localhost:4300/ (and its profiler front end on 4301)
npm run orchestrator   # in another terminal
```

`npm run tools` clones and builds what agents and the page use, under `<stateDir>/tools/`: profiler-cli and the
profiler front end (from firefox-devtools/profiler), fx-tests (mozilla/aretestsfastyet), md-viewer and claude-profiler.
They follow their repositories' main; nothing from your PATH is used for them.

## Running

The page and the orchestrator restart on their own when `src/` changes; the orchestrator only once the typecheck
and the tests pass. An open page reloads itself after the server restarts. Ctrl-C stops either; a second Ctrl-C
stops it at once.

## Design

Design docs, read in this order:
- [docs/MVP.md](docs/MVP.md): what gets built first, and how the factory updates without stopping
- [docs/WORKFLOW.md](docs/WORKFLOW.md): the full target workflow
- [docs/COMPONENTS.md](docs/COMPONENTS.md): scripts and prompts
- [docs/PROMPTS.md](docs/PROMPTS.md): every prompt in full (generated, `node src/tools/prompts-doc.ts`)
- [docs/CONTRACTS.md](docs/CONTRACTS.md): conventions between the pieces
- [docs/ORCHESTRATOR.md](docs/ORCHESTRATOR.md): what the orchestrator does at each step
- [docs/mockup-mvp.html](docs/mockup-mvp.html): status page mockup for the first version
- [docs/mockup.html](docs/mockup.html): status page mockup for the full design
- [docs/initial-prompt.md](docs/initial-prompt.md): the original request
- [docs/research/](docs/research/): how the current skills-based workflow works, and which existing tools to reuse
