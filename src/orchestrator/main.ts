// node src/orchestrator/main.ts [--dry-run]
//
// The loop of docs/ORCHESTRATOR.md. A tick runs on any change to commands.jsonl or the jobs
// directory, and at least every 30 s: execute new commands, record finished jobs (try.ts watch
// lines as they arrive), then start what next() asks for, within the caps, review comments first.
// Everything it knows comes from the state files, so it can be restarted at any time.
//
// --dry-run (or "dryRun" in the config): starts no agents, and passes --dry-run to every CLI,
// which then refuses try pushes and Phabricator or Bugzilla writes.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { toolsBin } from "../cli/tools.ts";
import { loadConfig } from "../config.ts";
import { delivered, sendToInbox } from "../agents/inbox.ts";
import { freeDiskGB, MIN_FREE_GB, WORKTREE_GB } from "../lib/disk.ts";
import { execOk } from "../lib/exec.ts";
import { processNewCommands, readCommands } from "../state/commands.ts";
import { eventsPath, listRequests, readEvents, readEventsFrom } from "../state/events.ts";
import { folder } from "../state/fold.ts";
import { cancelJob, jobDir, jobStatus, reconcile, type ExitInfo } from "../state/jobs.ts";
import type { Command, FactoryConfig, JobId, JobView, RequestId, RequestState } from "../types.ts";
import { commandEffects } from "./commands.ts";
import { appendEventSafe } from "./event-data.ts";
import { handleWatchLines } from "./handlers.ts";
import { compiledRoom, pickEvictions, poolRoom } from "./pool.ts";
import { CANCELLED, itemWorktrees, next, requestSummary, type Action, type Ctx, type WorktreeBuild } from "./next.ts";
import { DEFAULT_PRIORITY, reportPath, shortHash, type JobPlan } from "./plan.ts";
import { commitExists, defaultCliCommand, finishJob, jsonLines, readOut, readReport, startPlan, type RunnerDeps } from "./runner.ts";
import { viewBuilder, type JobRecord, type View } from "./view.ts";

export const TICK_MS = 30_000;
// Claude Code rewrites ~/.claude.json as it starts, without a lock: agents starting together corrupted it (and lost
// your login). One agent starts at a time, this far apart; the others start at the next ticks.
export const AGENT_START_GAP_MS = 2_000;
export const PRESENCE_MS = 30 * 60_000;
const MAX_PLANNING_ROUNDS = 20;

export interface OrchestratorOptions {
  config: FactoryConfig;
  configPath: string;
  codeVersion: string;
  factoryRoot?: string;
  cliCommand?: (tool: string) => string[];
  commitExists?: (cwd: string, sha: string) => boolean;
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
  private readonly folds = new Map<RequestId, { offset: number; fold: ReturnType<typeof folder>; views: ReturnType<typeof viewBuilder>; loaded?: Loaded }>();
  private readonly deferred: { request: RequestId; plan: JobPlan }[] = []; // commands' jobs waiting for their worktree
  private readonly planErrors = new Set<string>(); // failed:plan:<hash> keys raised by this process // visible=true presence commands, in order
  private ticking: Promise<void> | undefined;
  private again = false;
  private lastAgentStart = -Infinity;
  private startTimer: NodeJS.Timeout | undefined;
  // This planning pass's places in the worktree pool (config.worktreePool), and the idle worktrees picked to make room.
  private pool: { claim: (key: string, build?: WorktreeBuild) => boolean } | undefined;
  private evicting = new Set<string>();
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
      commitExists: opts.commitExists ?? commitExists,
    };
  }

  // Each request's fold goes on from where it stopped: only the lines appended since are read (reading them all
  // took seconds a round). Its state is the same object until they change it.
  private load(id: RequestId): Loaded {
    let f = this.folds.get(id);
    // Shorter than what was read: rewritten (a test's lost event), read again from the start.
    if (f && statSync(eventsPath(this.config.stateDir, id)).size < f.offset) f = undefined;
    const { events, offset } = readEventsFrom(this.config.stateDir, id, f?.offset ?? 0);
    if (f?.loaded && events.length === 0) return f.loaded;
    if (!f) {
      if (events.length === 0) throw new Error(`${id} has no events`);
      f = { offset: 0, fold: folder(events[0]), views: viewBuilder() };
      this.folds.set(id, f);
    }
    f.fold.apply(events);
    f.views.apply(events);
    f.offset = offset;
    f.loaded = { s: f.fold.state(), view: f.views.view };
    return f.loaded;
  }

  // The pool's room this pass: worktreePool minus the items' worktrees there or being made, within what the disk has
  // room for. Each item worktree to make claims a place; the ones refused are this pass's demand.
  private openPool(): Map<string, WorktreeBuild> {
    const size = this.config.worktreePool ?? 2 * this.config.maxAgents;
    const present = this.requests().flatMap((id) => {
      const { s, view } = this.load(id);
      // One removed outside the factory (by hand) is no longer there; those you took over are yours, not the pool's.
      return itemWorktrees(s, view, this.config.worktreesDir).filter((w) => (!w.made || existsSync(join(this.config.worktreesDir, w.name))) && s.items[w.item]?.state !== "taken over");
    });
    for (const name of [...this.evicting]) if (!present.some((w) => w.name === name)) this.evicting.delete(name);
    const disk = Math.floor((freeDiskGB(this.config.worktreesDir) - MIN_FREE_GB) / WORKTREE_GB);
    const room = poolRoom(size, present.length, disk);
    const claimed = new Map<string, WorktreeBuild>();
    const demand = new Map<string, WorktreeBuild>();
    this.pool = {
      claim: (key, build = "artifact") => {
        if (claimed.has(key)) return true;
        if (claimed.size < room && compiledRoom(build, present, [...claimed.values()])) {
          claimed.set(key, build);
          return true;
        }
        // A compiled build's tree waits for one of its kind to be freed: only those are picked for it.
        demand.set(key, build);
        return false;
      },
    };
    this.poolPresent = present;
    return demand;
  }

  // As many idle worktrees as items wait for one, those unused the longest, are picked; their requests remove them
  // (pruneWorktrees) at the next pass.
  private closePool(demand: Map<string, WorktreeBuild>): void {
    if (!demand.size) return;
    const more = pickEvictions(this.poolPresent, this.evicting, [...demand.values()]);
    for (const name of more) this.evicting.add(name);
    if (more.length) this.again = true;
  }
  private poolPresent: ReturnType<typeof itemWorktrees> = [];

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
      freeDiskGB: freeDiskGB(this.config.worktreesDir),
      ...(this.pool ? { claimWorktree: (key: string, build?: WorktreeBuild) => this.pool!.claim(`${s.id} ${key}`, build), evicting: this.evicting } : {}),
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
      events: (id) => readEvents(this.config.stateDir, id),
      other: (id) => (existsSync(join(this.config.stateDir, "requests", id)) ? this.load(id).s : undefined),
      plan: (job) => {
        const path = join(jobDir(this.config.stateDir, job), "plan.json");
        return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as JobPlan) : undefined;
      },
    });
    // The click is recorded as done once its job has started: the page never shows it done with nothing running (a
    // button back for a moment).
    const executed = effects.filter((e) => e.type === "event" && e.event.type === "command-executed");
    for (const e of [...effects.filter((e) => !executed.includes(e)), ...executed]) {
      switch (e.type) {
        case "event":
          appendEventSafe(this.config.stateDir, e.event.type === "request-created" ? { ...e.event, t: c.t } : e.event);
          break;
        // A retry waits like any job for its worktree to be free; a job outside worktrees starts now.
        case "start":
          // An agent waits its turn too (AGENT_START_GAP_MS): eighteen retries clicked together started together.
          if (inWorktree(this.config, e.plan) || e.plan.kind === "agent") this.deferred.push({ request: loaded!.s.id, plan: e.plan });
          else this.start(loaded!.s.id, e.plan);
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
        case "inbox":
          sendToInbox(this.config.stateDir, e.session, e.message);
          break;
        case "copy-report": {
          // Only agents that succeeded have one.
          const from = reportPath(this.config, e.from, e.job);
          if (existsSync(from)) {
            mkdirSync(dirname(reportPath(this.config, e.to, e.job)), { recursive: true });
            copyFileSync(from, reportPath(this.config, e.to, e.job));
          }
          break;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Finished jobs

  private async collect(): Promise<void> {
    for (const id of this.requests()) {
      // Your messages its agents got since (inbox.ts): before their runs' ends, which resume them with the others.
      for (const m of this.load(id).s.agentMessages.filter((x) => x.delivered === undefined)) {
        const at = delivered(this.config.stateDir, m.session).get(m.msg);
        if (at) appendEventSafe(this.config.stateDir, { type: "agent-message-delivered", request: id, msg: m.msg, at });
      }
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
    const demand = this.openPool();
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
    this.closePool(demand);
    // Commands' jobs (a retry…) first; they skip the caps but not the worktree lock. The retry reopened its key,
    // so next() plans it too: the retry's job (an agent resumed where it stopped) is the one that runs.
    const retried = new Set(this.deferred.map((d) => `${d.request} ${d.plan.purpose.key}`));
    starts = starts.filter((st) => !retried.has(`${st.request} ${st.plan.purpose.key}`));
    const lock = this.startDeferred(only);
    const running = this.requests().flatMap((id) => Object.values(this.load(id).s.jobs).filter((j) => j.endedAt === undefined));
    let agents = running.filter((j) => j.kind === "agent").length;
    let builds = running.filter((j) => j.kind === "build").length;
    starts.sort((a, b) => (a.plan.priority ?? DEFAULT_PRIORITY) - (b.plan.priority ?? DEFAULT_PRIORITY));
    for (const { request, plan } of starts) {
      if (!only && plan.kind === "agent" && agents >= this.config.maxAgents) continue;
      if (!only && plan.kind === "build" && builds >= this.config.maxBuilds) {
        if (plan.item && this.load(request).s.items[plan.item].state !== "waiting for a build slot") {
          appendEventSafe(this.config.stateDir, { type: "item-state", request, item: plan.item, state: "waiting for a build slot" });
        }
        continue;
      }
      if (plan.kind === "agent" && !this.agentMayStart()) continue;
      if (!lock(plan)) continue;
      if (plan.kind === "agent") {
        agents++;
        this.lastAgentStart = this.now();
      }
      if (plan.kind === "build") builds++;
      this.start(request, plan);
    }
  }

  // Whether an agent may start now (AGENT_START_GAP_MS since the last one started); if not, a tick comes once it may.
  private agentMayStart(): boolean {
    const wait = this.lastAgentStart + (this.config.agentStartGapMs ?? AGENT_START_GAP_MS) - this.now();
    if (wait <= 0) return true;
    this.startTimer ??= setTimeout(() => {
      this.startTimer = undefined;
      void this.tick();
    }, wait);
    return false;
  }

  // Commands' jobs whose worktree is free; the lock, with them in it, for the jobs started after them.
  private startDeferred(only?: RequestId): (plan: JobPlan) => boolean {
    const running = this.requests().flatMap((id) => Object.values(this.load(id).s.jobs).filter((j) => j.endedAt === undefined));
    const lock = worktreeLock(this.config, running);
    for (const d of this.deferred.filter((d) => !only || d.request === only)) {
      if (d.plan.kind === "agent" && !this.agentMayStart()) continue;
      if (!lock(d.plan)) continue;
      if (d.plan.kind === "agent") this.lastAgentStart = this.now();
      this.deferred.splice(this.deferred.indexOf(d), 1);
      this.start(d.request, d.plan);
    }
    return lock;
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
    clearTimeout(this.startTimer);
  }
}

// One job at a time changes or reads a worktree's checkout (a push detaches it at the approved commits): the
// returned function takes a plan's worktree, or says it's busy and the plan waits for a later tick. Authors work
// in their own worktrees.
// A script or build in a worktree: one at a time there.
function inWorktree(config: FactoryConfig, j: { kind: string; cwd: string }): boolean {
  return j.kind !== "agent" && j.cwd.startsWith(join(config.worktreesDir, "/"));
}

export function worktreeLock(config: FactoryConfig, running: Pick<JobView, "kind" | "cwd">[]): (plan: Pick<JobPlan, "kind" | "cwd">) => boolean {
  const busy = new Set(running.filter((j) => inWorktree(config, j)).map((j) => j.cwd));
  return (plan) => {
    if (!inWorktree(config, plan)) return true;
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
  // The factory's own tools (tools.ts update) for its scripts too: failures.ts runs fx-tests.
  process.env.PATH = `${toolsBin(config.stateDir)}${delimiter}${process.env.PATH ?? ""}`;
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
