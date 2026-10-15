// Plays the orchestrator's loop without processes, for the tests of next(), handlers and commands:
// next() → its events appended and its jobs "started"; complete() finishes a job through the
// handlers as the runner would.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderPrompt } from "../agents/run.ts";
import type { EventInput } from "../state/events.ts";
import { foldEvents } from "../state/fold.ts";
import type { Event, FactoryConfig, JobId, RequestKind, RequestState } from "../types.ts";
import { handleFinished } from "./handlers.ts";
import { next, type Action } from "./next.ts";
import type { JobPlan } from "./plan.ts";
import type { JobPurpose } from "../types.ts";
import { buildView, type View } from "./view.ts";

export const ID = "r-20261015-test";
export const T0 = Date.parse("2026-10-15T08:00:00.000Z");
export const HOUR = 3600_000;

export const config: FactoryConfig = {
  port: 0,
  stateDir: "/state",
  firefoxRepo: "/ff",
  worktreesDir: "/wt",
  baseRef: "origin/main",
  claudeCommand: ["claude"],
  stackViewerCommand: ["stack-viewer"],
  profilerOrigin: "http://localhost:4242",
  maxAgents: 4,
  maxBuilds: 2,
  dryRun: false,
};

export class Scenario {
  events: Event[] = [];
  now = T0;
  present = true;
  presentSince: number | undefined = T0;
  readonly outputs = new Map<JobId, string>();
  readonly reports = new Map<JobId, unknown>();
  private n = 0;
  lastActions: Action[] = [];

  constructor(kind: RequestKind, fields: { folder?: string; rev?: string; text?: string } = {}) {
    this.add({ type: "request-created", request: ID, kind, text: fields.text ?? "", ...fields });
  }

  add(e: EventInput): void {
    this.events.push({ v: 1, t: new Date(this.now).toISOString(), ...e } as Event);
    this.now += 1000;
  }

  state(): RequestState {
    return foldEvents(this.events);
  }

  view(): View {
    return buildView(this.events);
  }

  next(): Action[] {
    const view = this.view();
    return next(this.state(), {
      config,
      now: this.now,
      presence: { present: this.present, ...(this.present && this.presentSince !== undefined ? { since: this.presentSince } : {}) },
      view,
      output: (job) => this.outputs.get(job) ?? "",
      report: (job) => this.reports.get(job),
    });
  }

  // One pass of the loop: next()'s events, then its jobs started. Returns the started keys.
  step(): string[] {
    const actions = this.next();
    this.lastActions = actions;
    for (const a of actions) if (a.type === "event") this.add(a.event);
    const keys: string[] = [];
    for (const a of actions) {
      if (a.type !== "start") continue;
      this.startJob(a.plan);
      keys.push(a.plan.purpose.key);
    }
    return keys;
  }

  // Passes until nothing new happens; returns every key started on the way.
  settle(): string[] {
    const all: string[] = [];
    for (let i = 0; i < 20; i++) {
      const before = this.events.length;
      all.push(...this.step());
      if (this.events.length === before) break;
    }
    return all;
  }

  startJob(plan: JobPlan): JobId {
    // As the runner would: a missing placeholder throws.
    if (plan.agent?.vars) renderPrompt(readFileSync(fileURLToPath(new URL(`../../prompts/${plan.name}.md`, import.meta.url)), "utf8"), plan.agent.vars);
    const job = `j-${++this.n}`;
    this.add({
      type: "job-started",
      request: ID,
      job,
      ...(plan.item ? { item: plan.item } : {}),
      kind: plan.kind,
      name: plan.name,
      pid: 1,
      pidStartTime: 1,
      cmd: plan.cli ? [plan.cli.tool, ...plan.cli.args] : (plan.cmd ?? ["claude"]),
      cwd: plan.cwd,
      codeVersion: "test",
      ...(plan.agent ? { sessionId: plan.agent.sessionId, model: "m" } : {}),
      purpose: plan.purpose,
    } as EventInput);
    for (const e of plan.startEvents ?? []) this.add(e);
    this.plans.set(job, plan);
    return job;
  }
  readonly plans = new Map<JobId, JobPlan>();

  running(key: string): JobId {
    const rec = this.view().byKey.get(key)?.at(-1);
    if (!rec || rec.end) throw new Error(`no running job for ${key}; running: ${this.view().jobs.filter((j) => !j.end).map((j) => j.purpose.key).join(", ")}`);
    return rec.job;
  }

  // Finishes the running job of a key: successful ones go through the handlers.
  complete(key: string, result: { output?: unknown; report?: unknown; exitCode?: number; error?: string } = {}): JobId {
    const job = this.running(key);
    const rec = this.view().jobs.find((j) => j.job === job)!;
    if (result.output !== undefined) this.outputs.set(job, typeof result.output === "string" ? result.output : JSON.stringify(result.output));
    if (result.report !== undefined) this.reports.set(job, result.report);
    const exitCode = result.exitCode ?? 0;
    if (exitCode === 0 && result.error === undefined) {
      if (result.report !== undefined) this.add({ type: "agent-report", request: ID, job, ...(rec.item ? { item: rec.item } : {}), prompt: rec.name, report: result.report });
      const h = handleFinished({ state: this.state(), view: this.view(), config, job: rec, output: this.outputs.get(job) ?? "", report: result.report, reportOf: (j) => this.reports.get(j) });
      for (const e of h.events) this.add(e);
    }
    this.add({ type: "job-finished", request: ID, job, exitCode, durationMs: 1, ...(result.error ? { error: result.error } : {}) });
    return job;
  }

  plan(key: string): JobPlan {
    const job = this.view().byKey.get(key)?.at(-1)?.job;
    const p = job && this.plans.get(job);
    if (!p) throw new Error(`no plan for ${key}`);
    return p;
  }

  purpose(key: string): JobPurpose {
    return this.plan(key).purpose;
  }

  open(): string[] {
    return this.state().needsUser.map((n) => n.key);
  }

  of<T extends Event["type"]>(type: T): Extract<Event, { type: T }>[] {
    return this.events.filter((e): e is Extract<Event, { type: T }> => e.type === type);
  }
}

export const feedback = { feedback: [] };
export const sha = (c: string) => c.repeat(40);
