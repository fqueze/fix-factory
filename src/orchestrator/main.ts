// node src/orchestrator/main.ts [--dry-run]
//
// The loop of docs/ORCHESTRATOR.md. A tick runs on any change to commands.jsonl or the jobs
// directory, and at least every 30 s: execute new commands, record finished jobs (try.ts watch
// lines as they arrive), then start what next() asks for, within the caps, review comments first.
// Everything it knows comes from the state files, so it can be restarted at any time.
//
// --dry-run (or "dryRun" in the config): starts no agents, and passes --dry-run to every CLI,
// which then refuses try pushes and Phabricator or Bugzilla writes.
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { execOk } from "../lib/exec.ts";
import { processNewCommands, readCommands } from "../state/commands.ts";
import { listRequests, readEvents } from "../state/events.ts";
import { foldEvents } from "../state/fold.ts";
import { cancelJob, jobDir, jobStatus, reconcile, type ExitInfo } from "../state/jobs.ts";
import type { Command, FactoryConfig, JobId, JobView, RequestId, RequestState } from "../types.ts";
import { commandEffects } from "./commands.ts";
import { appendEventSafe } from "./event-data.ts";
import { handleWatchLines } from "./handlers.ts";
import { CANCELLED, next, requestSummary, type Action, type Ctx } from "./next.ts";
import { DEFAULT_PRIORITY, shortHash, type JobPlan } from "./plan.ts";
import { defaultCliCommand, finishJob, jsonLines, readOut, readReport, startPlan, type RunnerDeps } from "./runner.ts";
import { buildView, type JobRecord, type View } from "./view.ts";

export const TICK_MS = 30_000;
export const PRESENCE_MS = 30 * 60_000;
const MAX_PLANNING_ROUNDS = 20;

export interface OrchestratorOptions {
  config: FactoryConfig;
  configPath: string;
  codeVersion: string;
  factoryRoot?: string;
  cliCommand?: (tool: string) => string[];
  now?: () => number;
  dryRun?: boolean;
}

interface Loaded {
  s: RequestState;
  view: View;
}

export class Orchestrator {
  private readonly config: FactoryConfig;
  private readonly deps: RunnerDeps;
  private readonly now: () => number;
  private readonly dryRun: boolean;
  private readonly watchOffsets = new Map<JobId, number>();
  private presenceTimes: number[] = [];
  private readonly deferred: { request: RequestId; plan: JobPlan }[] = []; // commands' jobs waiting for their worktree
  private readonly planErrors = new Set<string>(); // failed:plan:<hash> keys raised by this process // visible=true presence commands, in order
  private ticking: Promise<void> | undefined;
  private again = false;
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: OrchestratorOptions) {
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
    this.dryRun = opts.dryRun ?? opts.config.dryRun;
    const factoryRoot = opts.factoryRoot ?? resolve(import.meta.dirname, "..", "..");
    this.deps = {
      config: opts.config,
      configPath: opts.configPath,
      factoryRoot,
      codeVersion: opts.codeVersion,
      cliCommand: opts.cliCommand ?? defaultCliCommand(factoryRoot),
    };
  }

  private load(id: RequestId): Loaded {
    const events = readEvents(this.config.stateDir, id);
    return { s: foldEvents(events), view: buildView(events) };
  }

  private requests(): RequestId[] {
    return listRequests(this.config.stateDir);
  }

  // Present: a visible page sent a presence command in the last 30 min. The streak starts at the
  // first of a run of presence commands less than 30 min apart.
  presence(): { present: boolean; since?: number } {
    const times = this.presenceTimes;
    const last = times.at(-1);
    if (last === undefined || this.now() - last > PRESENCE_MS) return { present: false };
    let i = times.length - 1;
    while (i > 0 && times[i] - times[i - 1] <= PRESENCE_MS) i--;
    return { present: true, since: times[i] };
  }

  private notePresence(c: Command): void {
    if (c.cmd === "presence" && c.visible) this.presenceTimes.push(Date.parse(c.t));
  }

  private ctx(s: RequestState, view: View): Ctx {
    return {
      config: this.config,
      now: this.now(),
      presence: this.presence(),
      view,
      output: (job) => readOut(this.config, job),
      report: (job) => readReport(this.config, s.id, job),
      activeRequests: () =>
        this.requests()
          .map((id) => this.load(id).s)
          .filter((r) => r.step !== "done" && r.kind !== "unrouted")
          .map((r) => ({ id: r.id, summary: requestSummary(r) })),
    };
  }

  // Startup: re-attach to running jobs, cancel orphaned ones (their step restarts through next()'s
  // retry), and count lost ones as failures.
  async startup(): Promise<void> {
    mkdirSync(join(this.config.stateDir, "jobs"), { recursive: true });
    for (const c of readCommands(this.config.stateDir, 0).commands) this.notePresence(c);
    for (const id of this.requests()) {
      const { s } = this.load(id);
      const running = Object.values(s.jobs).filter((j) => j.endedAt === undefined);
      for (const { job, status } of reconcile(this.config.stateDir, running)) {
        if (status.state === "orphaned") {
          await cancelJob(this.config.stateDir, job);
          this.fail(id, job, "orphaned at restart: cancelled, the step starts again");
        } else if (status.state === "lost") {
          this.fail(id, job, "lost: no process and no exit.json");
        }
      }
    }
  }

  private fail(request: RequestId, job: JobId, error: string): void {
    const { s, view } = this.load(request);
    const rec = view.jobs.find((j) => j.job === job)!;
    finishJob(this.deps, s, view, rec, { exitCode: -1, endedAt: new Date(this.now()).toISOString(), error });
  }

  tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.again = false;
        await processNewCommands(this.config.stateDir, (c) => this.execute(c));
        await this.collect();
        this.plan();
      } while (this.again);
    })().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  // -------------------------------------------------------------------------
  // Commands

  // A command that fails is recorded as failed, so the cursor moves on and the loop goes on.
  private async execute(c: Command): Promise<void> {
    try {
      await this.executeCommand(c);
    } catch (e) {
      const detail = `failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      process.stderr.write(`command ${c.id} (${c.cmd}) ${detail}\n`);
      if (c.request !== undefined && this.requests().includes(c.request)) {
        appendEventSafe(this.config.stateDir, { type: "command-executed", request: c.request, command: c.id, cmd: c.cmd, ok: false, detail });
      }
    }
  }

  private async executeCommand(c: Command): Promise<void> {
    if (c.cmd === "presence") {
      this.notePresence(c);
      return;
    }
    const request = c.request;
    const global = c.cmd === "tell-factory" && request === undefined;
    const all = global ? this.requests().map((id) => this.load(id).s) : [];
    if (all.some((s) => s.fromCommand === c.id)) return; // already executed
    const loaded = request !== undefined && this.requests().includes(request) ? this.load(request) : undefined;
    if (loaded?.view.executed.has(c.id)) return;
    const effects = commandEffects(c, {
      unroutable: all.filter((s) => s.kind === "unrouted" && s.step !== "done" && s.needsUser.some((n) => n.key.startsWith("failed:"))),
      config: this.config,
      state: loaded?.s,
      view: loaded?.view,
      exists: (id) => existsSync(join(this.config.stateDir, "requests", id)),
      plan: (job) => {
        const path = join(jobDir(this.config.stateDir, job), "plan.json");
        return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as JobPlan) : undefined;
      },
    });
    for (const e of effects) {
      switch (e.type) {
        case "event":
          appendEventSafe(this.config.stateDir, e.event.type === "request-created" ? { ...e.event, t: c.t } : e.event);
          break;
        // A retry waits like any job for its worktree to be free.
        case "start":
          this.deferred.push({ request: loaded!.s.id, plan: e.plan });
          break;
        case "cancel": {
          const exit = await cancelJob(this.config.stateDir, e.job);
          const { s, view } = this.load(e.request);
          const rec = view.jobs.find((j) => j.job === e.job);
          if (rec && !rec.end) finishJob(this.deps, s, view, rec, { exitCode: exit.state === "finished" ? exit.exitCode : -1, endedAt: new Date(this.now()).toISOString(), error: CANCELLED });
          break;
        }
        case "start-now":
          this.plan(e.request);
          break;
        case "allow-push":
          mkdirSync(join(this.config.stateDir, "allow-push"), { recursive: true });
          writeFileSync(join(this.config.stateDir, "allow-push", e.sessionId), new Date(this.now()).toISOString() + "\n");
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Finished jobs

  private async collect(): Promise<void> {
    for (const id of this.requests()) {
      const running = Object.values(this.load(id).s.jobs).filter((j) => j.endedAt === undefined);
      for (const j of running) {
        const status = jobStatus(this.config.stateDir, j.job, j);
        const { s, view } = this.load(id);
        const rec = view.jobs.find((r) => r.job === j.job)!;
        if (rec.kind === "try-watch" && status.state !== "orphaned") this.readWatch(s, view, rec);
        if (status.state === "finished") {
          this.watchOffsets.delete(j.job);
          const fresh = this.load(id);
          try {
            finishJob(this.deps, fresh.s, fresh.view, rec, status satisfies ExitInfo);
          } catch (e) {
            // This job fails; the loop and the other jobs go on.
            appendEventSafe(this.config.stateDir, { type: "job-finished", request: id, job: j.job, exitCode: status.exitCode, durationMs: 0, error: `recording the job failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 1500) });
          }
        } else if (status.state === "lost") {
          this.fail(id, j.job, "lost: no process and no exit.json");
        } else if (status.state === "orphaned") {
          await cancelJob(this.config.stateDir, j.job);
          this.fail(id, j.job, "orphaned: cancelled, the step starts again");
        }
      }
    }
  }

  private readWatch(s: RequestState, view: View, rec: JobRecord): void {
    const text = readOut(this.config, rec.job);
    const { lines, next: offset } = jsonLines(text, this.watchOffsets.get(rec.job) ?? 0);
    this.watchOffsets.set(rec.job, offset);
    if (lines.length === 0) return;
    for (const e of handleWatchLines(s, view, rec.purpose.push!, lines)) appendEventSafe(this.config.stateDir, e);
  }

  // -------------------------------------------------------------------------
  // Planning

  private start(request: RequestId, plan: JobPlan): void {
    // A dry run starts no agent, and no raw command: those can't be given --dry-run.
    if (this.dryRun && (plan.agent || plan.cmd)) {
      const text = `Dry run: ${plan.name} not started (${plan.purpose.key}).`;
      if (!this.load(request).s.notes.some((n) => n.text === text)) appendEventSafe(this.config.stateDir, { type: "note", request, text });
      return;
    }
    startPlan(this.deps, request, this.dryRun ? withDryRun(plan) : plan);
  }

  private planningFailed(request: RequestId, e: unknown): void {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    process.stderr.write(`planning ${request} failed: ${e instanceof Error ? e.stack : message}\n`);
    const key = `failed:plan:${shortHash([message])}`;
    if (this.planErrors.has(key)) return;
    this.planErrors.add(key);
    appendEventSafe(this.config.stateDir, { type: "note", request, text: `The orchestrator can't plan this request: ${message}` });
    appendEventSafe(this.config.stateDir, { type: "needs-user", request, key, action: "The orchestrator can't plan this request", detail: message });
  }

  // Runs next() for every request (or one, for start-now, which also skips the caps) until it
  // stops writing events, then starts its jobs within the caps.
  plan(only?: RequestId): void {
    let starts: { request: RequestId; plan: JobPlan }[] = [];
    for (let round = 0; round < MAX_PLANNING_ROUNDS; round++) {
      starts = [];
      let wrote = false;
      for (const id of only ? [only] : this.requests()) {
        try {
          const { s, view } = this.load(id);
          const actions: Action[] = next(s, this.ctx(s, view));
          // It plans again: its earlier "can't plan" ⚑ is over.
          for (const n of s.needsUser.filter((x) => x.key.startsWith("failed:plan:"))) {
            appendEventSafe(this.config.stateDir, { type: "user-done", request: id, key: n.key, byFactory: true });
            this.planErrors.delete(n.key);
          }
          for (const a of actions) {
            if (a.type === "event") {
              appendEventSafe(this.config.stateDir, a.event);
              wrote = true;
            } else {
              starts.push({ request: id, plan: a.plan });
            }
          }
        } catch (e) {
          // One request's trouble doesn't stop the others; it shows on its page, once per error.
          this.planningFailed(id, e);
        }
      }
      if (!wrote) break;
    }
    // Commands' jobs (a retry…) first; they skip the caps but not the worktree lock. The retry reopened its key,
    // so next() plans it too: the retry's job (an agent resumed where it stopped) is the one that runs.
    const deferred = this.deferred.filter((d) => !only || d.request === only);
    const retried = new Set(this.deferred.map((d) => `${d.request} ${d.plan.purpose.key}`));
    starts = starts.filter((st) => !retried.has(`${st.request} ${st.plan.purpose.key}`));
    const running = this.requests().flatMap((id) => Object.values(this.load(id).s.jobs).filter((j) => j.endedAt === undefined));
    let agents = running.filter((j) => j.kind === "agent").length;
    let builds = running.filter((j) => j.kind === "build").length;
    const lock = worktreeLock(this.config, running);
    for (const d of deferred) {
      if (!lock(d.plan)) continue;
      this.deferred.splice(this.deferred.indexOf(d), 1);
      this.start(d.request, d.plan);
    }
    starts.sort((a, b) => (a.plan.priority ?? DEFAULT_PRIORITY) - (b.plan.priority ?? DEFAULT_PRIORITY));
    for (const { request, plan } of starts) {
      if (!only && plan.kind === "agent" && agents >= this.config.maxAgents) continue;
      if (!only && plan.kind === "build" && builds >= this.config.maxBuilds) {
        if (plan.item && this.load(request).s.items[plan.item].state !== "waiting for a build slot") {
          appendEventSafe(this.config.stateDir, { type: "item-state", request, item: plan.item, state: "waiting for a build slot" });
        }
        continue;
      }
      if (!lock(plan)) continue;
      if (plan.kind === "agent") agents++;
      if (plan.kind === "build") builds++;
      this.start(request, plan);
    }
  }

  // -------------------------------------------------------------------------
  // The process

  run(): void {
    const kick = () => {
      this.tick().catch((e: unknown) => process.stderr.write(`tick failed: ${e instanceof Error ? e.stack : String(e)}\n`));
    };
    this.watchers.push(watch(this.config.stateDir, (_t, name) => name === "commands.jsonl" && kick()));
    this.watchers.push(watch(join(this.config.stateDir, "jobs"), { recursive: true }, (_t, name) => (name?.endsWith("exit.json") || name?.endsWith("out.log")) && kick()));
    this.timer = setInterval(kick, TICK_MS);
    kick();
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    clearInterval(this.timer);
  }
}

// One job at a time changes or reads a worktree's checkout (a push detaches it at the approved commits): the
// returned function takes a plan's worktree, or says it's busy and the plan waits for a later tick. Authors work
// in their own worktrees.
export function worktreeLock(config: FactoryConfig, running: Pick<JobView, "kind" | "cwd">[]): (plan: Pick<JobPlan, "kind" | "cwd">) => boolean {
  const inWorktree = (j: { kind: string; cwd: string }) => j.kind !== "agent" && j.cwd.startsWith(join(config.worktreesDir, "/"));
  const busy = new Set(running.filter(inWorktree).map((j) => j.cwd));
  return (plan) => {
    if (!inWorktree(plan)) return true;
    if (busy.has(plan.cwd)) return false;
    busy.add(plan.cwd);
    return true;
  };
}

// The CLIs that go through runCli take --dry-run, before any "--" (after it, try.ts passes
// everything to mach try). lint-text.ts has no side effect and no such flag.
export function withDryRun(plan: JobPlan): JobPlan {
  if (!plan.cli || !plan.cli.tool.endsWith(".ts") || plan.cli.tool === "lint-text.ts") return plan;
  const args = [...plan.cli.args];
  const end = args.indexOf("--");
  args.splice(end === -1 ? args.length : end, 0, "--dry-run");
  return { ...plan, cli: { ...plan.cli, args } };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean" } } });
  const configPath = resolve(process.env.FACTORY_CONFIG ?? "factory.config.json");
  const config = loadConfig(configPath);
  const factoryRoot = resolve(import.meta.dirname, "..", "..");
  const codeVersion = (await execOk(["git", "rev-parse", "HEAD"], { cwd: factoryRoot })).trim();
  const o = new Orchestrator({ config, configPath, codeVersion, factoryRoot, dryRun: values["dry-run"] ?? config.dryRun });
  await o.startup();
  o.run();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      o.stop();
      process.exit(0);
    });
  }
}
