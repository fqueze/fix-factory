// The pipeline of docs/MVP.md as a pure function: (request state, context) → actions.
//
// Every job has a key (JobPurpose.key). next() never starts a key that already has a job, so it can
// run as often as needed: it re-derives where each request stands from the events and the job
// outputs, and asks for what's missing. A failed job is retried once under the same key (an agent
// is resumed with what went wrong), then raises `failed:<job>` for you.
//
// Keys carry what makes the work different: an author round names the job it answers, a stack
// assembly names a hash of the commits it assembles. redo-step bumps an epoch that ends up in the
// keys of that step (step events per step) or of that item (item-state "not started" events).
import { basename, dirname } from "node:path";
import type { Annotation } from "../cli/annotations.ts";
import type { ClusterGroup, CollectedFailure, TryRow, TryTable } from "../cli/failures.ts";
import type { ReviewerSuggestion } from "../cli/phab.ts";
import type { ImportedCommit } from "../cli/stack/import.ts";
import type { OrderOutput } from "../cli/stack/order.ts";
import type { DryRunResult } from "../cli/try.ts";
import { COMMITS_CHANGED } from "../cli/try.ts";
import { REQUEST_STEPS } from "../server/commands.ts";
import type { EventInput } from "../state/events.ts";
import type {
  AddressReviewReport,
  BugDraft,
  FactoryConfig,
  FailureGroup,
  InvestigateReport,
  ItemId,
  ItemState,
  ItemView,
  JobPurpose,
  JobId,
  NeedsUser,
  PatchId,
  PatchView,
  PushId,
  RequestId,
  RequestState,
  RequestStep,
  ReviewPatchReport,
} from "../types.ts";
import {
  artifactsDir,
  dataPath,
  outPath,
  reportPath,
  requestDir,
  DEFAULT_PRIORITY,
  REVIEW_PRIORITY,
  sessionIdFor,
  shortHash,
  slug,
  type JobPlan,
} from "./plan.ts";
import type {
  ClassifyAnnotationReport,
  ClassifyReviewCommentsReport,
  MergeClustersReport,
  PlanTryPushesReport,
  PriorArtVerdictReport,
  ResolveConflictReport,
  ReviewStackReport,
  TriageTryReport,
  WriteAnnotationPatchesReport,
} from "../types.ts";
import { succeeded, type JobRecord, type View } from "./view.ts";

export interface Ctx {
  config: FactoryConfig;
  now: number; // ms
  presence: { present: boolean; since?: number }; // since: when the current presence streak began
  view: View;
  output: (job: JobId) => string; // out.log of a finished job
  report: (job: JobId) => unknown; // the validated report of a finished agent job
  activeRequests: () => { id: RequestId; summary: string }[]; // routed and not done, for route-request
}

// One line for route-request's list of active requests.
export function requestSummary(s: RequestState): string {
  const what = s.kind === "burndown" ? `Flakiness burndown of ${s.folder}` : `Fix the failures of try push ${s.rev}`;
  const text = s.text.split("\n")[0].trim();
  return `${what} (step: ${s.step})${text ? `: ${text.slice(0, 200)}` : ""}`;
}

export type Action = { type: "event"; event: EventInput } | { type: "start"; plan: JobPlan };

export const HOUR = 3600_000;
export const EARLY_WORK_LIST_MS = 2 * HOUR;
export const SUBMIT_IMPORT_MS = 2 * 60_000;
export const ANNOTATIONS_ITEM = "i-annotations";
export const LINT_ROUNDS = 2;
export const REVIEW_ROUNDS = 3;
export const STACK_REVIEW_ROUNDS = 3;
export const CANCELLED = "cancelled by you";
// Jobs with an external side effect that a failure doesn't undo: a try push can fail after mach try
// pushed (a Lando timeout), and a retry would push again. They come to you instead.
const NO_RETRY = new Set(["push"]);

const SETTLED: ItemState[] = ["reviewed", "in stack", "in try", "waiting for review", "addressing review comments", "fixed", "landed", "left as-is", "handed back"];
const WITH_PATCHES: ItemState[] = ["reviewed", "in stack", "in try", "waiting for review", "addressing review comments", "fixed", "landed"];
const TERMINAL: ItemState[] = ["left as-is", "handed back", "landed", "fixed"];

const at = (step: RequestStep) => REQUEST_STEPS.indexOf(step);

export function next(s: RequestState, ctx: Ctx): Action[] {
  const p = new Planner(s, ctx);
  p.run();
  return p.actions;
}

// Ids and names other modules derive the same way.
export function patchId(item: ItemId, index: number): PatchId {
  const base = `p-${item.replace(/^i-/, "")}`;
  return index === 0 ? base : `${base}-${index + 1}`;
}

// Not file-bug:<patch>, which earlier versions raised too early: a needs-user key is raised once.
export function fileBugKey(patch: PatchId): string {
  return `file-bug:${patch}:meta-bug-step`;
}

export function stackId(folder: string): string {
  return slug(folder) || "root";
}

export function folderOf(test: string): string {
  return dirname(test);
}

// The commits an author's report hands over, by the prompt that produced it.
export function commitsOf(name: string, report: unknown): string[] {
  switch (name) {
    case "investigate-and-fix": {
      const r = report as InvestigateReport;
      return r.state === "fix verified locally" ? r.commits : [];
    }
    case "write-annotation-patches": {
      const r = report as WriteAnnotationPatchesReport;
      return r.runIf ? [r.runIf] : [];
    }
    case "address-review": {
      const r = report as AddressReviewReport;
      return r.state === "addressed" ? r.commits : [];
    }
  }
  return [];
}

export function itemEpochOf(view: View, item: ItemId): string {
  const n = view.itemResets.get(item) ?? 0;
  return n > 0 ? `@${n}` : "";
}

export function authorJobsOf(view: View, item: ItemId): JobRecord[] {
  const prefix = `author:${item}${itemEpochOf(view, item)}:`;
  return view.jobs.filter((j) => j.purpose.what === "author" && j.purpose.key.startsWith(prefix));
}

// Authors are resumed in their own session (the latest fresh one: start-agent begins a new one),
// one run at a time.
export function resumeAuthorPlan(
  request: string,
  view: View,
  item: ItemId,
  reason: string,
  input: { message: string } | { prompt: string; vars: Record<string, string | number> },
  state: ItemState,
): JobPlan | "busy" | undefined {
  const jobs = authorJobsOf(view, item);
  const session = jobs.filter((j) => j.purpose.reason === "initial" || j.purpose.reason === "start").at(-1);
  if (!session?.sessionId) return undefined;
  if (jobs.at(-1)!.end === undefined) return "busy";
  const fromPrompt = "prompt" in input;
  return {
    purpose: { key: "", what: "author", item, reason },
    kind: "agent",
    name: fromPrompt ? input.prompt : session.name,
    item,
    cwd: session.cwd,
    agent: { sessionId: session.sessionId, resume: true, ...(fromPrompt ? { vars: input.vars } : { message: input.message }) },
    startEvents: [{ type: "item-state", request, item, state, detail: reason }],
  };
}

interface StackInfo {
  id: string;
  folder: string;
  hash: string; // of the author commits it assembles
  patches: { id: PatchId; source: string; item: ItemId }[];
  wt?: string;
  branch: string;
  ready: boolean; // assembled, ordered, reviewed and summarized for this hash
}

class Planner {
  readonly actions: Action[] = [];
  private readonly startedKeys = new Set<string>();
  private readonly raisedKeys = new Set<string>();
  private readonly itemStates = new Map<ItemId, ItemState>();
  private readonly newItems = new Map<ItemId, FailureGroup>();
  private stepSet = false;
  private readonly stackInfos = new Map<string, StackInfo>();
  readonly s: RequestState;
  readonly ctx: Ctx;

  constructor(s: RequestState, ctx: Ctx) {
    this.s = s;
    this.ctx = ctx;
  }

  get view(): View {
    return this.ctx.view;
  }
  get config(): FactoryConfig {
    return this.ctx.config;
  }

  run(): void {
    if (this.s.step === "done") {
      this.cleanup();
      return;
    }
    this.computeStacks();
    this.earlyFileBugs();
    this.request();
    this.firstSignal();
    this.pushes();
    this.workList();
    for (const item of Object.values(this.s.items)) this.item(item);
    this.stacks();
    this.bugEdits();
    this.verify();
    this.metaBug();
    this.submit();
    this.reviewComments();
    this.landing();
  }

  // -------------------------------------------------------------------------
  // Primitives

  event(event: EventInput): void {
    this.actions.push({ type: "event", event });
  }

  private ev<T extends EventInput["type"]>(type: T, fields: Omit<Extract<EventInput, { type: T }>, "type" | "request" | "v" | "t">): EventInput {
    return { type, request: this.s.id, ...fields } as unknown as EventInput;
  }

  setStep(step: RequestStep): void {
    if (this.stepSet || this.s.step === step) return;
    this.stepSet = true;
    this.event(this.ev("step", { step }));
  }

  setItem(item: ItemId, state: ItemState, detail?: string): void {
    const current = this.itemStates.get(item) ?? this.s.items[item]?.state;
    if (current === state) return;
    this.itemStates.set(item, state);
    this.event(this.ev("item-state", { item, state, ...(detail === undefined ? {} : { detail }) }));
  }

  raise(key: string, fields: Omit<NeedsUser, "key" | "since">): void {
    if (this.view.raised.has(key) || this.raisedKeys.has(key)) return;
    this.raisedKeys.add(key);
    this.event(this.ev("needs-user", { key, ...fields }));
  }

  clear(key: string): void {
    if (this.s.needsUser.some((n) => n.key === key)) this.event(this.ev("user-done", { key }));
  }

  note(text: string): void {
    this.event(this.ev("note", { text }));
  }

  // The latest successful job of the key; undefined while it's missing, running or failed.
  // Starts it when missing (make), retries a failure once, then raises failed:<job>.
  want(key: string, make?: () => JobPlan): JobRecord | undefined {
    if (this.startedKeys.has(key)) return undefined;
    const jobs = this.view.byKey.get(key) ?? [];
    const last = jobs.at(-1);
    if (!last) {
      if (make) this.start(key, make());
      return undefined;
    }
    if (!last.end) return undefined;
    if (succeeded(last)) return last;
    // You cancelled it: nothing happens until you say what to do instead.
    if (last.end.error?.startsWith(CANCELLED)) return undefined;
    if (jobs.length < 2 && !NO_RETRY.has(last.purpose.what)) {
      const retry = this.retryPlan(last, make);
      if (retry) this.start(key, retry);
    } else {
      this.blocked(last);
    }
    return undefined;
  }

  private start(key: string, plan: JobPlan): void {
    plan.purpose.key = key;
    this.startedKeys.add(key);
    this.actions.push({ type: "start", plan });
  }

  private retryPlan(last: JobRecord, make?: () => JobPlan): JobPlan | undefined {
    if (last.kind === "agent" && last.sessionId) {
      const error = last.end?.error ?? `exit code ${last.end?.exitCode}`;
      const message = error.startsWith("invalid report")
        ? `Your JSON report is invalid:\n${error}\n\nReturn the whole report again, fixed.`
        : `The run ended without a valid report (${error}). Continue where you stopped, then end with the JSON report.`;
      return { purpose: { ...last.purpose }, kind: "agent", name: last.name, item: last.item, cwd: last.cwd, agent: { sessionId: last.sessionId, resume: true, message } };
    }
    return make?.();
  }

  private blocked(last: JobRecord): void {
    const detail = (last.end?.error ?? `exit code ${last.end?.exitCode}`).slice(0, 500);
    if (last.purpose.what === "push" && detail.startsWith(COMMITS_CHANGED)) {
      this.raise(`failed:${last.job}`, { action: `Push ${last.purpose.push} not made: the stack changed since its dry run. Ask the factory to plan it again (redo-step)`, detail, job: last.job });
      return;
    }
    if (last.purpose.what === "route") {
      // Nothing to retry by hand: the text is all there is. The next text from the main box supersedes it (commands.ts).
      this.raise(`failed:${last.job}`, { action: "The factory couldn't tell what this is: rephrase it in the main box", detail, job: last.job });
      return;
    }
    const action = NO_RETRY.has(last.purpose.what) ? `${last.name} failed (not retried: it may have happened)` : `${last.name} failed twice`;
    this.raise(`failed:${last.job}`, { action, detail, job: last.job, ...(last.item ? { item: last.item } : {}) });
    if (last.item && this.s.items[last.item]) this.setItem(last.item, "blocked", `${last.name} failed`);
  }

  out<T>(r: JobRecord): T {
    return JSON.parse(this.ctx.output(r.job)) as T;
  }

  rep<T>(r: JobRecord): T {
    return this.ctx.report(r.job) as T;
  }

  // redo-step appends a step event; the step's keys get its count, so its jobs run again. A request
  // starts in "request" without a step event, the other steps with one.
  stepEpoch(step: RequestStep): string {
    const n = (this.view.stepCount.get(step) ?? 0) - (step === "request" ? 0 : 1);
    return n > 0 ? `@${n}` : "";
  }

  itemEpoch(item: ItemId): string {
    return itemEpochOf(this.view, item);
  }

  // -------------------------------------------------------------------------
  // Plan builders

  cli(what: string, tool: string, args: string[], opts: Partial<Omit<JobPlan, "purpose" | "cli">> & { purpose?: Partial<JobPurpose> } = {}): JobPlan {
    const { purpose, ...rest } = opts;
    const name = `${tool} ${args.find((a) => !a.startsWith("-")) ?? ""}`.trim();
    return { kind: "script", name, cwd: requestDir(this.config, this.s.id), ...rest, purpose: { key: "", what, ...purpose }, cli: { tool, args } };
  }

  agent(what: string, prompt: string, vars: Record<string, string | number>, opts: Partial<Omit<JobPlan, "purpose" | "agent">> & { purpose?: Partial<JobPurpose>; key: string }): JobPlan {
    const { purpose, key, ...rest } = opts;
    return {
      kind: "agent",
      name: prompt,
      cwd: requestDir(this.config, this.s.id),
      ...rest,
      purpose: { key: "", what, ...purpose },
      agent: { sessionId: sessionIdFor(this.s.id, key), resume: false, vars },
    };
  }

  // A fresh agent, keyed: the session id derives from the key.
  wantAgent(key: string, what: string, prompt: string, vars: Record<string, string | number>, opts: Partial<Omit<JobPlan, "purpose" | "agent">> & { purpose?: Partial<JobPurpose> } = {}): JobRecord | undefined {
    return this.want(key, () => this.agent(what, prompt, vars, { ...opts, key }));
  }

  worktree(name: string, purpose: Partial<JobPurpose> = {}): JobPlan {
    return this.cli("worktree", "worktree.ts", ["create", name, "--base", this.config.baseRef, "--build", "artifact"], {
      kind: "build",
      cwd: this.config.firefoxRepo,
      purpose,
      ...(purpose.item ? { item: purpose.item } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // 1. Request

  private request(): void {
    if (this.s.step !== "request") return;
    if (this.s.kind === "unrouted") {
      // Its handler routes the request: a kind (and the next pass goes on), or done, forwarded.
      const key = `route${this.stepEpoch("request")}`;
      this.want(key, () => {
        const requests = this.ctx.activeRequests().filter((r) => r.id !== this.s.id);
        const requestsFile = dataPath(this.config, this.s.id, "requests.txt");
        const plan = this.agent("route", "route-request", { text: this.s.text, requestsFile }, { key, purpose: { requests: requests.map((r) => r.id) } });
        plan.files = [{ path: requestsFile, content: requests.length ? requests.map((r) => `${r.id}  ${r.summary}\n`).join("") : "(no active requests)\n" }];
        return plan;
      });
      return;
    }
    if (this.s.kind === "burndown") {
      this.setStep("first signal");
      return;
    }
    if (this.s.rev && !this.s.pushes.initial) {
      this.event(this.ev("try-pushed", { push: "initial", rev: this.s.rev, url: `https://treeherder.mozilla.org/jobs?repo=try&revision=${this.s.rev}` }));
    }
    this.setStep("work list");
  }

  // -------------------------------------------------------------------------
  // 2. First signal (burndown)

  private signalWorktree(): { path: string; branch: string } | undefined {
    const wt = this.want("wt:signal", () => this.worktree(`${this.s.id}-signal`));
    return wt && this.out<{ path: string; branch: string }>(wt);
  }

  private skipIfs(): { a: Annotation; index: number }[] | undefined {
    const ann = this.want(`annotations${this.stepEpoch("first signal")}`, () => this.cli("annotations", "annotations.ts", ["list", this.s.folder ?? "", "--repo", this.config.firefoxRepo], { cwd: this.config.firefoxRepo }));
    if (!ann) return undefined;
    return this.out<Annotation[]>(ann)
      .map((a, index) => ({ a, index }))
      .filter((x) => x.a.kind === "skip-if");
  }

  private firstSignal(): void {
    if (this.s.kind !== "burndown" || this.s.step !== "first signal") return;
    const skips = this.skipIfs();
    if (!skips) return;
    if (skips.length === 0) {
      this.note(`No skip-if in ${this.s.folder}: the work list comes from its failures on central.`);
      this.setStep("work list");
      return;
    }
    const wt = this.signalWorktree();
    const classified = skips.map(({ a, index }) => {
      const bug = a.bug && "summary" in a.bug ? a.bug : undefined;
      const r = this.wantAgent(`classify:${index}${this.stepEpoch("first signal")}`, "classify", "classify-annotation", {
        annotation: `${a.kind} = ${a.condition}`,
        manifest: `${a.manifest} [${a.test}]`,
        bug: a.bug?.id ?? "unknown",
        summary: bug?.summary ?? "",
        comment: (bug?.firstComment ?? a.comment ?? "").slice(0, 3000),
      }, { purpose: { index } });
      return r && { ...a, classification: this.rep<ClassifyAnnotationReport>(r) };
    });
    if (!wt || classified.some((c) => !c)) return;
    if (!classified.some((c) => c!.classification.kind !== "unclear")) {
      this.note("Every skip-if is unclear: the work list comes from the folder's failures on central.");
      this.setStep("work list");
      return;
    }
    if (!this.s.items[ANNOTATIONS_ITEM] && !this.newItems.has(ANNOTATIONS_ITEM)) {
      const group: FailureGroup = { message: "skip-if annotations", tests: [...new Set(skips.map((x) => x.a.manifest))], configs: [] };
      this.newItems.set(ANNOTATIONS_ITEM, group);
      this.event(this.ev("item-created", { item: ANNOTATIONS_ITEM, folder: this.s.folder ?? "", group }));
    }
    const item = this.s.items[ANNOTATIONS_ITEM];
    if (!item || !SETTLED.includes(item.state)) return;
    const debug = this.debugCommit();
    if (!debug) {
      this.note("No flakiness skip to remove: the work list comes from the folder's failures on central.");
      this.setStep("work list");
      return;
    }
    const e = this.stepEpoch("first signal");
    const plan = this.wantAgent(
      `plan:unskip${e}`,
      "plan-pushes",
      "plan-try-pushes",
      {
        goal: `reproduce the failures hidden by the flakiness skip-ifs of ${this.s.folder} that the DEBUG commit removes`,
        failuresFile: dataPath(this.config, this.s.id, "annotations.json"),
        initialPushFile: dataPath(this.config, this.s.id, "no-initial-push.json"),
        branch: wt.branch,
        worktree: wt.path,
        base: this.config.baseRef,
      },
      { cwd: wt.path, files: [{ path: dataPath(this.config, this.s.id, "no-initial-push.json"), content: '{"note": "none: this is the un-skip push"}\n' }] },
    );
    if (!plan) return;
    const pushes = this.rep<PlanTryPushesReport>(plan).pushes;
    const ids = pushes.map((_, i) => `unskip${e.replace("@", "-")}${pushes.length === 1 ? "" : `-${i + 1}`}`);
    const dry = pushes.map((push, i) => this.dryRun(ids[i], push.tryArgs, push.purpose, wt.path));
    if (dry.some((d) => !d)) return;
    if (ids.every((id) => this.s.pushes[id]?.rev || dry[ids.indexOf(id)]!.duplicateOf !== undefined)) this.setStep("work list");
  }

  private dryRun(push: PushId, args: string[], purpose: string, cwd: string, stack?: string): DryRunResult | undefined {
    const r = this.want(`dry-run:${push}`, () => {
      // try.ts refuses a duplicate of a push still pending.
      const pending = Object.values(this.s.pushes)
        .filter((p) => p.id !== push && p.result === undefined)
        .flatMap((p) => {
          const d = this.view.byKey.get(`dry-run:${p.id}`)?.find(succeeded);
          return d ? [{ push: p.id, ...this.out<DryRunResult>(d) }] : [];
        })
        .map(({ push: id, tryTaskConfig, commits }) => ({ push: id, tryTaskConfig, commits }));
      const file = dataPath(this.config, this.s.id, `pending-${push}.json`);
      return this.cli("dry-run", "try.ts", ["dry-run", "--cwd", cwd, "--pending", file, "--", ...args], {
        cwd,
        files: [{ path: file, content: JSON.stringify(pending) + "\n" }],
        purpose: { push, args, cwd, purpose, ...(stack ? { stack } : {}) },
      });
    });
    return r && this.out<DryRunResult>(r);
  }

  // -------------------------------------------------------------------------
  // Try pushes, in any step: push once approved, watch, fetch the failed jobs' artifacts.

  private pushes(): void {
    for (const push of Object.values(this.s.pushes)) {
      const dry = this.view.byKey.get(`dry-run:${push.id}`)?.find(succeeded);
      if (!push.rev && dry && this.view.done.has(`approve-push:${push.id}`)) {
        const { args = [], cwd = this.config.firefoxRepo, stack } = dry.purpose;
        const commits = this.out<DryRunResult>(dry).commits;
        const items = stack ? (this.stackInfos.get(stack)?.patches.map((x) => x.item) ?? []) : [];
        const pushed = this.want(`push:${push.id}`, () =>
          this.cli("push", "try.ts", ["push", "--cwd", cwd, "--expect-commits", commits.join(","), "--", ...args], {
            cwd,
            purpose: { push: push.id },
            startEvents: [...new Set(items)].map((item) => this.ev("item-state", { item, state: "in try" })),
          }),
        );
        if (!pushed) continue;
        const o = this.out<{ rev?: string; landoJobId?: number; dryRun?: boolean }>(pushed);
        if (o.landoJobId !== undefined && !o.rev) {
          this.want(`watch:${push.id}`, () => this.cli("watch", "try.ts", ["watch", "--lando", String(o.landoJobId)], { kind: "try-watch", purpose: { push: push.id } }));
        }
        continue;
      }
      if (push.rev && push.result === undefined) {
        this.want(`watch:${push.id}`, () => this.cli("watch", "try.ts", ["watch", push.rev!], { kind: "try-watch", purpose: { push: push.id } }));
      }
    }
    for (const f of this.view.tryFailures) {
      if (f.retryId === undefined) continue;
      this.want(`artifacts:${f.taskId}:${f.retryId}`, () =>
        this.cli("artifacts", "artifacts.ts", ["fetch", f.taskId, "--run", String(f.retryId), "--into", `${artifactsDir(this.config)}/${f.taskId}`], { purpose: { push: f.push } }),
      );
    }
  }

  // Step 3 runs at whichever comes first, the push finishing or 2 h after it started, then again
  // when it finishes.
  // Run names carry the step's epoch e, so a redone step runs again.
  private pushRuns(push: PushId, e: string): string[] {
    const p = this.s.pushes[push];
    if (!p?.rev) return [];
    const runs: string[] = [];
    const pushedAt = this.view.pushedAt.get(push);
    const earlyStarted = [...this.view.byKey.keys()].some((k) => k.endsWith(`:${push}:early${e}`));
    if (earlyStarted || (p.result === undefined && pushedAt !== undefined && this.ctx.now - pushedAt >= EARLY_WORK_LIST_MS)) runs.push(`early${e}`);
    if (p.result) runs.push(`final${e}`);
    return runs;
  }

  // -------------------------------------------------------------------------
  // 3. Work list

  private signalPushes(): PushId[] {
    return Object.keys(this.s.pushes).filter((id) => id === "initial" || id.startsWith("unskip"));
  }

  private workList(): void {
    // The push's final run can still add items while the first ones are in their stacks.
    if (at(this.s.step) < at("work list") || at(this.s.step) > at("verify on try")) return;
    const pushes = this.signalPushes();
    const goal = this.s.text.trim() || "find the failures to fix";
    const e = this.stepEpoch("work list");
    let firstRunDone = false;
    if (pushes.length === 0 && this.s.kind === "burndown") {
      const groups = this.groups("folder", `folder${e}`, this.s.folder ?? "");
      if (groups) {
        this.createItems(groups);
        firstRunDone = true;
      }
    }
    for (const push of pushes) {
      const rev = this.s.pushes[push].rev!;
      for (const run of this.pushRuns(push, e)) {
        const groups = this.groups(push, run, rev);
        const table = this.want(`try-table:${push}:${run}`, () => this.cli("try-table", "failures.ts", ["try-table", rev], { purpose: { push } }));
        if (!groups || !table) continue;
        this.createItems(groups);
        const t = this.out<TryTable>(table);
        if (t.unparsed.length > 0) {
          const triage = this.wantAgent(`triage:${push}:${run}`, "triage", "triage-try", { rev, goal, tableFile: outPath(this.config, table.job), logsDir: artifactsDir(this.config) }, { purpose: { push } });
          if (!triage) continue;
          this.itemsFromTriage(this.rep<TriageTryReport>(triage));
        }
        firstRunDone = true;
      }
    }
    if (this.s.step === "work list" && firstRunDone) {
      if (Object.keys(this.s.items).length + this.newItems.size === 0) {
        this.note("No failure to fix.");
        this.setStep("done");
      } else {
        this.setStep("investigate and fix");
      }
    }
  }

  // collect → cluster → merge-clusters (when there's anything to merge). Singles are never merged
  // (a generic message is no shared cause), so merge-clusters only sees the groups: an agent can't
  // drop a single.
  private groups(scope: string, run: string, target: string): FailureGroup[] | undefined {
    const collect = this.want(`collect:${scope}:${run}`, () => this.cli("collect", "failures.ts", ["collect", target]));
    if (!collect) return undefined;
    if (this.out<CollectedFailure[]>(collect).length === 0) return [];
    const cluster = this.want(`cluster:${scope}:${run}`, () => this.cli("cluster", "failures.ts", ["cluster", outPath(this.config, collect.job)]));
    if (!cluster) return undefined;
    const { groups, singles } = this.out<{ groups: ClusterGroup[]; singles: ClusterGroup[] }>(cluster);
    const strip = ({ key: _, ...g }: ClusterGroup): FailureGroup => g;
    if (groups.length <= 1) return [...groups, ...singles].map(strip);
    const clustersFile = dataPath(this.config, this.s.id, `clusters-${scope}-${run}.json`);
    const merge = this.wantAgent(`merge:${scope}:${run}`, "merge", "merge-clusters", { clustersFile }, { files: [{ path: clustersFile, content: JSON.stringify({ groups }, null, 2) + "\n" }] });
    if (!merge) return undefined;
    const byKey = new Map(groups.map((g) => [g.key, g]));
    const merged = this.rep<MergeClustersReport>(merge).groups.map((g) => {
      const sources = g.from.map((k) => byKey.get(k)).filter((x) => x !== undefined);
      const rates = sources.map((x) => x.ratePerWeek).filter((x) => x !== undefined);
      const taskIds = [...new Set(sources.flatMap((x) => x.taskIds ?? []))];
      return {
        message: g.message,
        tests: g.tests,
        configs: g.configs,
        ...(rates.length ? { ratePerWeek: Math.round(rates.reduce((a, b) => a + b, 0) * 10) / 10 } : {}),
        ...(taskIds.length ? { taskIds } : {}),
      };
    });
    return [...merged, ...singles.map(strip)];
  }

  private knownTests(): Set<string> {
    return new Set([...Object.values(this.s.items).flatMap((i) => i.group.tests), ...[...this.newItems.values()].flatMap((g) => g.tests)]);
  }

  // A later run finds the groups of the earlier ones again, possibly with more tests: a group is
  // known when one of its tests already has an item with its message. Not the message alone:
  // singles of different tests share generic messages such as "Test timed out".
  private createItems(groups: FailureGroup[]): void {
    const pair = (message: string, test: string) => `${message}\n${test}`;
    const known = new Set([...Object.values(this.s.items).map((i) => i.group), ...this.newItems.values()].flatMap((g) => g.tests.map((t) => pair(g.message, t))));
    for (const group of groups) {
      if (group.tests.length === 0 || group.tests.some((t) => known.has(pair(group.message, t)))) continue;
      this.createItem(group);
      for (const t of group.tests) known.add(pair(group.message, t));
    }
  }

  private createItem(group: FailureGroup): void {
    const base = `i-${slug(basename(group.tests[0]).replace(/\.[^.]*$/, "")) || "failure"}`;
    let id = base;
    for (let n = 2; this.s.items[id] || this.newItems.has(id); n++) id = `${base}-${n}`;
    this.newItems.set(id, group);
    this.event(this.ev("item-created", { item: id, folder: folderOf(group.tests[0]), group }));
  }

  // New and unexplained failures become work items; the rest is noted by the triage handler.
  private itemsFromTriage(report: TriageTryReport): void {
    const tests = this.knownTests();
    for (const c of report.cells) {
      if (c.verdict !== "still failing" || c.patch || !c.test || tests.has(c.test)) continue;
      tests.add(c.test);
      this.createItem({ message: c.evidence.slice(0, 300), tests: [c.test], configs: c.config ? [c.config] : [], ...(c.taskId ? { taskIds: [c.taskId] } : {}) });
    }
  }

  // -------------------------------------------------------------------------
  // 4. Investigate and fix, per item

  authorJobs(item: ItemId): JobRecord[] {
    return authorJobsOf(this.view, item);
  }

  latestAuthor(item: ItemId): JobRecord | undefined {
    return this.authorJobs(item).at(-1);
  }

  // The author's latest successful report, with the commits it hands over.
  private authorReport(item: ItemId): { job: JobRecord; commits: string[] } | undefined {
    const ok = this.authorJobs(item).filter(succeeded).at(-1);
    return ok && { job: ok, commits: commitsOf(ok.name, this.rep(ok)) };
  }

  // Round limits count from the author's latest fresh start or address-review run: review comments
  // begin a new conversation with the critical reviewer.
  private roundsSinceStart(item: ItemId, reason: string): number {
    const jobs = this.authorJobs(item);
    const start = jobs.findLastIndex((j) => j.purpose.reason === "initial" || j.purpose.reason === "start" || j.name === "address-review");
    return jobs.slice(start + 1).filter((j) => j.purpose.reason === reason).length;
  }

  resumeAuthor(item: ItemId, key: string, reason: string, message: string, state: ItemState = "investigating"): JobRecord | undefined {
    if (this.view.byKey.has(key)) return this.want(key);
    const plan = resumeAuthorPlan(this.s.id, this.view, item, reason, { message }, state);
    return plan === "busy" || plan === undefined ? undefined : this.want(key, () => plan);
  }

  private item(item: ItemView): void {
    if (TERMINAL.includes(item.state)) return;
    const e = this.itemEpoch(item.id);
    const prefix = `author:${item.id}${e}`;
    if (item.id === ANNOTATIONS_ITEM) {
      const wt = this.signalWorktree();
      if (!wt) return;
      this.want(`${prefix}:initial`, () =>
        this.agent("author", "write-annotation-patches", { folder: this.s.folder ?? "", annotations: dataPath(this.config, this.s.id, "annotations.json") }, {
          key: `${prefix}:initial`,
          item: item.id,
          cwd: wt.path,
          purpose: { item: item.id, reason: "initial" },
          files: [{ path: dataPath(this.config, this.s.id, "annotations.json"), content: JSON.stringify(this.annotationsInput(), null, 2) + "\n" }],
          startEvents: [this.ev("item-state", { item: item.id, state: "investigating" })],
        }),
      );
    } else {
      const test = item.group.tests[0];
      const prior = this.want(`prior-art:${item.id}${e}`, () => this.cli("prior-art", "bugzilla.ts", ["prior-art", test], { item: item.id, purpose: { item: item.id } }));
      const verdict =
        prior &&
        this.wantAgent(`prior-art-verdict:${item.id}${e}`, "prior-art-verdict", "prior-art-verdict", { test, facts: `in ${outPath(this.config, prior.job)}` }, { item: item.id, purpose: { item: item.id } });
      if (!verdict) return;
      const v = this.rep<PriorArtVerdictReport>(verdict);
      if (v.verdict === "active") {
        const key = `take-it:${item.id}`;
        this.raise(key, { action: `Someone may be on ${basename(test)}`, detail: v.quote.slice(0, 500), item: item.id });
        if (!this.view.done.has(key)) return;
      }
      const wt = this.want(`wt:${item.id}${e}`, () => this.worktree(`${this.s.id}-${item.id}${e.replace("@", "-")}`, { item: item.id }));
      if (!wt) return;
      const path = this.out<{ path: string }>(wt).path;
      const groupFile = dataPath(this.config, this.s.id, `items/${item.id}${e}.json`);
      const rate = item.group.ratePerWeek === undefined ? "" : `, ${item.group.ratePerWeek} failures/week`;
      const reuse = v.verdict === "reuse" && v.bug ? ` Bug ${v.bug} is already open for it: use it in the commit message.` : "";
      const tests = item.group.tests.length > 1 ? `${test} (and ${item.group.tests.length - 1} other tests)` : test;
      this.want(`${prefix}:initial`, () =>
        this.agent(
          "author",
          "investigate-and-fix",
          { test: tests, worktree: path, failureSummary: `"${item.group.message}" on ${item.group.configs.length} configs${rate}; the full group, with its configs and task ids, is in ${groupFile}.${reuse}` },
          {
            key: `${prefix}:initial`,
            item: item.id,
            cwd: path,
            purpose: { item: item.id, reason: "initial" },
            files: [{ path: groupFile, content: JSON.stringify(item.group, null, 2) + "\n" }],
            startEvents: [this.ev("item-state", { item: item.id, state: "investigating" })],
          },
        ),
      );
    }
    const latest = this.latestAuthor(item.id);
    if (!latest) return;
    if (!this.want(latest.purpose.key)) return;
    const author = this.authorReport(item.id)!;
    if (author.commits.length === 0) return;
    this.checkAndReview(item, author.job, author.commits);
  }

  private annotationsInput(): unknown[] {
    const skips = this.skipIfs() ?? [];
    return skips.map(({ a, index }) => {
      const r = this.view.byKey.get(`classify:${index}${this.stepEpoch("first signal")}`)?.find(succeeded);
      const c = r && this.rep<ClassifyAnnotationReport>(r);
      return { manifest: a.manifest, test: a.test, condition: a.condition, line: a.line, comment: a.comment, kind: c?.kind, reason: c?.reason };
    });
  }

  // import → lint (commit message, bug draft, replies) → critical review, with the round limits.
  private checkAndReview(item: ItemView, author: JobRecord, commits: string[]): void {
    const e = this.itemEpoch(item.id);
    const cwd = author.cwd;
    // Answers to review comments are checked first, like the comments themselves.
    const priority = author.name === "address-review" ? REVIEW_PRIORITY : DEFAULT_PRIORITY;
    const imp = this.want(`import:${author.job}`, () =>
      this.cli("import", "stack.ts", ["import", "--cwd", cwd, `${commits[0]}^..${commits.at(-1)}`], { cwd, item: item.id, priority, purpose: { item: item.id } }),
    );
    if (!imp) return;
    const patches = commits.map((sha, i) => ({ id: patchId(item.id, i), sha }));
    const lints: { job: JobRecord; what: string }[] = [];
    let pending = false;
    for (const p of patches) {
      const msg = this.want(`msg:${p.id}:${p.sha}`, () => this.cli("msg", "git", ["log", "-1", "--format=%B", p.sha], { cwd, item: item.id, priority, purpose: { item: item.id, patch: p.id } }));
      const lint = msg && this.want(`lint:${p.id}:${p.sha}`, () => this.cli("lint", "lint-text.ts", ["--kind", "commit", outPath(this.config, msg.job)], { item: item.id, priority, purpose: { item: item.id, patch: p.id } }));
      if (lint) lints.push({ job: lint, what: `the commit message of ${p.sha.slice(0, 12)}` });
      else pending = true;
    }
    const report = this.rep<InvestigateReport & AddressReviewReport>(author);
    const draftPatch = Object.values(this.s.patches).find((p) => p.item === item.id && p.bug === null && p.bugDraft);
    if (author.name === "investigate-and-fix" && report.bugDraft && draftPatch) {
      const file = dataPath(this.config, this.s.id, `drafts/${author.job}.json`);
      const lint = this.want(`lint-bug:${author.job}`, () =>
        this.cli("lint", "lint-text.ts", ["--kind", "bug", file], { item: item.id, files: [{ path: file, content: JSON.stringify(report.bugDraft) + "\n" }], purpose: { item: item.id, patch: draftPatch.id } }),
      );
      if (lint) lints.push({ job: lint, what: "the bug draft" });
      else pending = true;
    }
    if (author.name === "address-review") {
      for (const reply of report.replies) {
        const file = dataPath(this.config, this.s.id, `replies/${author.job}-${reply.commentId}.txt`);
        const lint = this.want(`lint-reply:${author.job}:${reply.commentId}`, () =>
          this.cli("lint", "lint-text.ts", ["--kind", "reply", file], { item: item.id, priority, files: [{ path: file, content: reply.text }], purpose: { item: item.id } }),
        );
        if (lint) lints.push({ job: lint, what: `the reply to comment ${reply.commentId}` });
        else pending = true;
      }
    }
    if (pending) return;
    const violations = lints.flatMap(({ job, what }) => this.out<{ violations: { rule: string; line?: number; text: string }[] }>(job).violations.map((v) => ({ ...v, what, job })));
    if (violations.length > 0) {
      const rounds = this.roundsSinceStart(item.id, "lint");
      if (rounds >= LINT_ROUNDS && !this.view.byKey.has(`author:${item.id}${e}:lint:${author.job}`)) {
        this.raise(`failed:${violations[0].job.job}`, { action: `Lint violations after ${LINT_ROUNDS} rounds`, detail: violations.map((v) => `${v.rule}: ${v.text}`).join("; ").slice(0, 500), job: violations[0].job.job, item: item.id });
        this.setItem(item.id, "blocked", "lint violations");
        return;
      }
      const list = violations.map((v) => `- ${v.what}, ${v.rule}${v.line ? ` (line ${v.line})` : ""}: ${v.text}`).join("\n");
      this.resumeAuthor(item.id, `author:${item.id}${e}:lint:${author.job}`, "lint", `lint-text.ts found these problems:\n${list}\n\nFix them, amending your commit (keep everything else), then end with the JSON report again.`);
      return;
    }
    const reviews = patches.map((p) =>
      this.wantAgent(`review:${p.id}:${author.job}`, "review", "review-patch", { sha: p.sha, worktree: cwd, report: reportPath(this.config, this.s.id, author.job) }, {
        cwd,
        priority,
        item: item.id,
        purpose: { item: item.id, patch: p.id, sha: p.sha },
        startEvents: [this.ev("item-state", { item: item.id, state: "in critical review" })],
      }),
    );
    if (reviews.some((r) => !r)) return;
    const findings = reviews.flatMap((r) => {
      const rep = this.rep<ReviewPatchReport>(r!);
      return rep.verdict === "findings" ? rep.findings.map((f) => ({ ...f, job: r! })) : [];
    });
    // Nits don't send the patch back (the review handler notes them); must-fix findings do.
    const mustFix = findings.filter((f) => f.severity === "must-fix");
    if (mustFix.length === 0) {
      if (!WITH_PATCHES.includes(item.state) || item.state === "addressing review comments") this.setItem(item.id, "reviewed");
      return;
    }
    const key = `author:${item.id}${e}:review:${author.job}`;
    const rounds = this.roundsSinceStart(item.id, "review");
    if (rounds >= REVIEW_ROUNDS && !this.view.byKey.has(key)) {
      const last = mustFix[0].job.job;
      this.raise(`failed:${last}`, { action: `No ok after ${REVIEW_ROUNDS} critical review rounds`, detail: mustFix.map((f) => f.text).join("; ").slice(0, 500), job: last, item: item.id });
      this.setItem(item.id, "blocked", "critical review");
      return;
    }
    const list = findings.map((f) => `- [${f.severity}]${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""} ${f.text}`).join("\n");
    this.resumeAuthor(item.id, key, "review", `A critical reviewer found these problems in your patch:\n${list}\n\nAddress them by amending your commit, then end with the JSON report again. Where you disagree with a finding, say why in the report's summary.`, "review findings");
  }

  // -------------------------------------------------------------------------
  // 5. Stack, per folder once every item in it is settled

  private computeStacks(): void {
    const folders = [...new Set(Object.values(this.s.items).map((i) => i.folder))];
    for (const folder of folders) {
      const items = Object.values(this.s.items).filter((i) => i.folder === folder);
      if (items.some((i) => !SETTLED.includes(i.state))) continue;
      const patches: StackInfo["patches"] = [];
      for (const item of items) {
        if (!WITH_PATCHES.includes(item.state)) continue;
        const author = this.authorReport(item.id);
        author?.commits.forEach((source, i) => {
          if (this.s.patches[patchId(item.id, i)]) patches.push({ id: patchId(item.id, i), source, item: item.id });
        });
      }
      if (patches.length === 0) continue;
      const id = stackId(folder);
      const wtJob = this.view.byKey.get(`wt:${id}`)?.find(succeeded);
      const hash = shortHash(patches.map((p) => `${p.id}=${p.source}`)) + this.stepEpoch("stack");
      const info: StackInfo = { id, folder, hash, patches, branch: `${this.s.id}-${id}`, ready: false };
      if (wtJob) info.wt = this.out<{ path: string }>(wtJob).path;
      info.ready = this.view.byKey.get(`summary:${id}:${hash}`)?.some(succeeded) ?? false;
      this.stackInfos.set(id, info);
    }
  }

  private stacks(): void {
    const step = at(this.s.step);
    if (step < at("investigate and fix") || step > at("verify on try")) return;
    for (const info of this.stackInfos.values()) this.buildStack(info);
    const items = Object.values(this.s.items);
    if (this.s.step === "investigate and fix" && this.newItems.size === 0 && items.every((i) => SETTLED.includes(i.state))) {
      if (items.every((i) => !WITH_PATCHES.includes(i.state))) {
        this.note("Every item ended without a patch.");
        this.setStep("done");
      } else {
        this.setStep("stack");
      }
    }
    if (this.s.step === "stack" && this.stackInfos.size > 0 && [...this.stackInfos.values()].every((i) => i.ready)) this.setStep("verify on try");
  }

  private buildStack(info: StackInfo): void {
    const { id, hash } = info;
    if (!this.want(`wt:${id}`, () => this.worktree(info.branch))) return;
    const wt = info.wt!;
    const prev = this.s.stacks[id];
    const bySource = new Map(info.patches.map((p) => [p.source, p]));
    // Keep the previous order across reassemblies, new patches last.
    const sources = [
      ...(prev?.order ?? []).map((pid) => info.patches.find((p) => p.id === pid)?.source).filter((x) => x !== undefined),
      ...info.patches.filter((p) => !prev?.order.includes(p.id)).map((p) => p.source),
    ];
    const patchesOf = (shas: string[]) => Object.fromEntries(shas.map((sha) => [sha.slice(0, 12), bySource.get(sha)!.id]));
    const key = `assemble:${id}:${hash}`;
    const reassembly = this.view.jobs.some((j) => j.purpose.what === "assemble" && j.purpose.stack === id && j.purpose.key !== key && !j.purpose.key.startsWith(`${key}:after:`));
    const first = this.want(key, () =>
      reassembly
        ? this.cli("assemble", "stack.ts", ["rewrite", "--cwd", wt, "--base", this.config.baseRef, "--branch", info.branch, "--leave-conflict", "--order", sources.join(",")], { cwd: wt, purpose: { stack: id, patches: patchesOf(sources) } })
        : this.cli("assemble", "stack.ts", ["assemble", "--cwd", wt, "--branch", info.branch, "--base", this.config.baseRef, "--leave-conflict", ...sources], { cwd: wt, purpose: { stack: id, patches: patchesOf(sources) } }),
    );
    // Follow the chain of conflicts: resolve-conflict, then assemble what's left.
    let cur = first;
    const mapped = new Set<string>();
    const empty = new Set<string>();
    while (cur) {
      const o = this.out<{ commits?: { sha: string; newSha: string }[]; mapping?: Record<string, string>; empty?: string[]; conflict?: { sha: string; files: string[] }; remaining?: string[] }>(cur);
      for (const c of o.commits ?? []) mapped.add(c.sha);
      for (const sha of Object.keys(o.mapping ?? {})) mapped.add(sha);
      for (const sha of o.empty ?? []) {
        mapped.add(sha);
        empty.add(sha);
      }
      if (!o.conflict) break;
      const conflict = o.conflict;
      const res = this.wantAgent(`resolve:${id}:${hash}:${conflict.sha}`, "resolve", "resolve-conflict", { sha: conflict.sha, base: info.branch, files: conflict.files.join(", ") }, {
        cwd: wt,
        purpose: { stack: id, sha: conflict.sha, patches: patchesOf([conflict.sha]) },
      });
      if (!res) return;
      const r = this.rep<ResolveConflictReport>(res);
      if (r.state !== "resolved" || !r.commit) {
        this.raise(`failed:${res.job}`, { action: "Approach conflict while assembling the stack", detail: r.explanation.slice(0, 500), job: res.job, stack: id });
        return;
      }
      mapped.add(conflict.sha);
      const remaining = o.remaining ?? [];
      if (remaining.length === 0) break;
      cur = this.want(`assemble:${id}:${hash}:after:${conflict.sha.slice(0, 12)}`, () =>
        this.cli("assemble", "stack.ts", ["assemble", "--cwd", wt, "--branch", info.branch, "--leave-conflict", ...remaining], { cwd: wt, purpose: { stack: id, patches: patchesOf(remaining) } }),
      );
    }
    if (!cur || sources.some((sha) => !mapped.has(sha))) return;
    // A change already in the base makes no commit: that patch is left out.
    const kept = info.patches.filter((p) => !empty.has(p.source));
    const inStack = kept.filter((p) => this.s.patches[p.id].worktree === wt);
    if (inStack.length < kept.length) return; // the handlers' patch events haven't landed yet
    const shaToPatch = Object.fromEntries(inStack.map((p) => [this.s.patches[p.id].sha.slice(0, 12), p.id]));
    const deps = this.want(`deps:${id}:${hash}`, () => this.cli("deps", "stack.ts", ["deps", "--cwd", wt, "--base", this.config.baseRef], { cwd: wt, purpose: { stack: id, patches: shaToPatch } }));
    const efforts = inStack.map((p) =>
      this.wantAgent(`effort:${p.id}:${p.source}`, "effort", "estimate-review-effort", { sha: this.s.patches[p.id].sha, worktree: wt }, { cwd: wt, purpose: { patch: p.id, stack: id } }),
    );
    if (!deps || efforts.some((x) => !x)) return;
    const value = (pid: PatchId) => this.s.items[this.s.patches[pid].item ?? ""]?.group.ratePerWeek;
    const orderFile = dataPath(this.config, this.s.id, `order-${id}-${hash}.json`);
    const ord = this.want(`order:${id}:${hash}`, () =>
      this.cli("order", "stack.ts", ["order", orderFile], {
        purpose: { stack: id },
        files: [
          {
            path: orderFile,
            content:
              JSON.stringify({
                patches: inStack.map((p) => {
                  const pv = this.s.patches[p.id];
                  return { id: p.id, effort: pv.effort, value: value(p.id), testOnly: pv.testOnly };
                }),
                deps: inStack.flatMap((p) => this.s.patches[p.id].deps),
                previous: prev?.order,
              }) + "\n",
          },
        ],
      }),
    );
    if (!ord) return;
    const order = this.out<OrderOutput>(ord).order;
    const assembled = sources.map((sha) => bySource.get(sha)!.id).filter((pid) => order.includes(pid));
    if (order.join() !== assembled.join()) {
      const re = this.want(`reorder:${id}:${hash}`, () =>
        this.cli("rewrite", "stack.ts", ["rewrite", "--cwd", wt, "--base", this.config.baseRef, "--branch", info.branch, "--order", order.map((pid) => this.s.patches[pid].sha).join(",")], {
          cwd: wt,
          purpose: { stack: id, patches: shaToPatch },
        }),
      );
      if (!re) return;
      if (this.out<{ conflict?: unknown }>(re).conflict) {
        this.raise(`failed:${re.job}`, { action: "Conflict while reordering the stack", detail: "stack.ts rewrite stopped on a conflict", job: re.job, stack: id });
        return;
      }
    }
    if (!prev || prev.order.join() !== order.join() || prev.worktree !== wt || prev.branch !== info.branch) {
      this.event(this.ev("stack", { stack: id, folder: info.folder, branch: info.branch, worktree: wt, base: this.config.baseRef, order, ...(prev?.summary ? { summary: prev.summary } : {}) }));
      return;
    }
    const depsFile = dataPath(this.config, this.s.id, `deps-${id}-${hash}.json`);
    const review = this.wantAgent(`review-stack:${id}:${hash}`, "review-stack", "review-stack", { base: this.config.baseRef, branch: info.branch, worktree: wt, depsFile }, {
      cwd: wt,
      purpose: { stack: id },
      files: [
        {
          path: depsFile,
          content:
            JSON.stringify(
              order.flatMap((pid) => this.s.patches[pid].deps.map((d) => ({ ...d, patchSha: this.s.patches[pid].sha, needsSha: this.s.patches[d.needs]?.sha }))),
              null,
              2,
            ) + "\n",
        },
      ],
    });
    if (!review) return;
    const mustFix = this.rep<ReviewStackReport>(review).findings.filter((f) => f.severity === "must-fix");
    if (mustFix.length > 0) {
      const rounds = this.view.jobs.filter((j) => j.purpose.what === "review-stack" && j.purpose.stack === id && j.end).length;
      if (rounds >= STACK_REVIEW_ROUNDS) {
        this.raise(`failed:${review.job}`, { action: `Stack review still has findings after ${STACK_REVIEW_ROUNDS} rounds`, detail: mustFix.map((f) => f.text).join("; ").slice(0, 500), job: review.job, stack: id });
        return;
      }
      const byItem = new Map<ItemId, string[]>();
      for (const f of mustFix) {
        const p = this.patchBySha(f.patch);
        const item = p?.item ?? inStack[0].item;
        byItem.set(item, [...(byItem.get(item) ?? []), `- ${p ? `${p.title}: ` : ""}${f.text}`]);
      }
      for (const [item, lines] of byItem) {
        this.resumeAuthor(item, `author:${item}${this.itemEpoch(item)}:stack-review:${review.job}`, "stack review", `The review of the whole stack found problems with your patch:\n${lines.join("\n")}\n\nAddress them by amending your commit, then end with the JSON report again.`);
      }
      return;
    }
    const summaryFile = dataPath(this.config, this.s.id, `summary-${id}-${hash}.json`);
    this.want(`summary:${id}:${hash}`, () =>
      this.cli("summary", "stack.ts", ["summary", summaryFile], {
        purpose: { stack: id },
        files: [
          {
            path: summaryFile,
            content:
              JSON.stringify({
                folder: info.folder,
                patches: order.map((pid) => {
                  const p = this.s.patches[pid];
                  return { id: pid, title: p.title, bug: p.bug, revision: p.revision, effort: p.effort, value: value(pid) };
                }),
              }) + "\n",
          },
        ],
      }),
    );
  }

  patchBySha(sha: string): PatchView | undefined {
    const short = sha.slice(0, 12);
    return Object.values(this.s.patches).find((p) => p.sha.startsWith(short));
  }

  // Bug numbers go in commit messages with stack.ts rewrite: your set-bug, and the meta bug for
  // the patches that don't need their own.
  private bugEdits(): void {
    if (at(this.s.step) < at("stack")) return;
    const meta = this.s.metaBug?.bug ?? null;
    for (const stack of Object.values(this.s.stacks)) {
      const info = this.stackInfos.get(stack.id);
      if (at(this.s.step) <= at("verify on try") && !info?.ready) continue;
      const edits: Record<PatchId, number> = {};
      for (const pid of stack.order) {
        const p = this.s.patches[pid];
        if (!p || !/^Bug X+\b/i.test(p.title)) continue;
        const bug = p.bug ?? (meta !== null && (p.testOnly || !p.bugDraft) ? meta : null);
        if (bug !== null) edits[pid] = bug;
      }
      if (Object.keys(edits).length === 0) continue;
      const file = dataPath(this.config, this.s.id, `edits-${stack.id}-${shortHash(Object.entries(edits).map(([k, v]) => `${k}=${v}`))}.json`);
      this.want(`rewrite-bugs:${stack.id}:${shortHash(Object.entries(edits).map(([k, v]) => `${k}=${v}:${this.s.patches[k].sha}`))}`, () =>
        this.cli("rewrite", "stack.ts", ["rewrite", "--cwd", stack.worktree, "--base", stack.base ?? this.config.baseRef, "--branch", stack.branch, "--order", stack.order.map((pid) => this.s.patches[pid].sha).join(","), "--edits", file], {
          cwd: stack.worktree,
          purpose: { stack: stack.id, edits, patches: Object.fromEntries(stack.order.map((pid) => [this.s.patches[pid].sha.slice(0, 12), pid])) },
          files: [{ path: file, content: JSON.stringify(Object.fromEntries(Object.entries(edits).map(([pid, bug]) => [this.s.patches[pid].sha, { bug }]))) + "\n" }],
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 6. Verify on try

  private patchFiles(p: PatchView): string[] {
    if (!p.item) return [];
    const author = this.authorReport(p.item);
    const imp = author && this.view.byKey.get(`import:${author.job.job}`)?.find(succeeded);
    if (!imp) return [];
    const index = author.commits.findIndex((_, i) => patchId(p.item!, i) === p.id);
    return this.out<ImportedCommit[]>(imp)[index]?.files ?? [];
  }

  // A failure in a test a patch touches, or in that patch's folder, goes to that patch's author.
  matchPatch(test: string, patches: PatchView[]): PatchView | undefined {
    return (
      patches.find((p) => this.patchFiles(p).includes(test)) ??
      patches.find((p) => {
        const folder = p.item ? this.s.items[p.item]?.folder : undefined;
        return folder !== undefined && (folderOf(test) === folder || test.startsWith(`${folder}/`));
      })
    );
  }

  private verifyPushes(info: StackInfo): PushId[] | undefined {
    const e = this.stepEpoch("verify on try");
    const stack = this.s.stacks[info.id];
    if (!stack || !info.wt) return undefined;
    let branch = stack.branch;
    const debug = this.s.kind === "burndown" ? this.debugCommit() : undefined;
    if (debug) {
      const tb = this.want(`try-branch:${info.id}:${info.hash}${e}`, () =>
        this.cli("try-branch", "stack.ts", ["assemble", "--cwd", info.wt!, "--branch", `${stack.branch}-try-${shortHash([info.hash, e]).slice(0, 6)}`, "--base", stack.branch, debug], { cwd: info.wt, purpose: { stack: info.id } }),
      );
      if (!tb) return undefined;
      branch = this.out<{ branch: string }>(tb).branch;
    }
    const failuresFile = dataPath(this.config, this.s.id, `failures-${info.id}.json`);
    const initialFile = dataPath(this.config, this.s.id, "initial-pushes.json");
    const planKey = `plan:verify:${info.id}:${info.hash}${e}`;
    const plan = this.wantAgent(planKey, "plan-pushes", "plan-try-pushes", {
      goal: `verify the fixes of the ${info.folder} stack: every failure below should be gone, with no new one`,
      failuresFile,
      initialPushFile: initialFile,
      branch,
      worktree: info.wt,
      base: stack.base ?? this.config.baseRef,
    }, {
      cwd: info.wt,
      purpose: { stack: info.id },
      files: [
        { path: failuresFile, content: JSON.stringify(info.patches.map((p) => ({ patch: p.id, title: this.s.patches[p.id].title, ...this.s.items[p.item].group })), null, 2) + "\n" },
        {
          path: initialFile,
          content:
            JSON.stringify(
              this.signalPushes().map((id) => {
                const push = this.s.pushes[id];
                const table = this.view.byKey.get(`try-table:${id}:final`)?.find(succeeded);
                return { push: id, purpose: push.purpose, command: push.command, rev: push.rev, result: push.result, summary: push.summary, resultsTable: table ? outPath(this.config, table.job) : undefined };
              }),
              null,
              2,
            ) + "\n",
        },
      ],
    });
    if (!plan) return undefined;
    const planned = this.rep<PlanTryPushesReport>(plan).pushes;
    const ids = planned.map((_, i) => `${info.id}-${shortHash([info.hash, e]).slice(0, 4)}-${i + 1}`);
    const dry = planned.map((push, i) => this.dryRun(ids[i], push.tryArgs, push.purpose, info.wt!, info.id));
    if (dry.some((d) => !d)) return undefined;
    return ids.filter((_, i) => dry[i]!.duplicateOf === undefined);
  }

  private debugCommit(): string | undefined {
    const author = this.authorJobs(ANNOTATIONS_ITEM).filter(succeeded).at(-1);
    return author && this.rep<WriteAnnotationPatchesReport>(author).debug;
  }

  private verify(): void {
    if (this.s.step !== "verify on try") return;
    // Every verification push's failures are routed, also those of a stack being redone: its
    // other authors still need to hear about theirs.
    for (const push of Object.values(this.s.pushes)) {
      const stack = this.view.byKey.get(`dry-run:${push.id}`)?.[0].purpose.stack;
      if (stack && this.s.stacks[stack] && push.rev) this.routeTryFailures(push.id, this.s.stacks[stack].order.map((pid) => this.s.patches[pid]));
    }
    let green = this.stackInfos.size > 0;
    for (const info of this.stackInfos.values()) {
      const pushes = info.ready ? this.verifyPushes(info) : undefined;
      if (!pushes || pushes.some((push) => this.s.pushes[push]?.result !== "green")) green = false;
    }
    if (green) this.setStep("meta bug");
  }

  private routeTryFailures(push: PushId, patches: PatchView[]): void {
    const p = this.s.pushes[push];
    for (const run of this.pushRuns(push, this.stepEpoch("verify on try"))) {
      const table = this.want(`try-table:${push}:${run}`, () => this.cli("try-table", "failures.ts", ["try-table", p.rev!], { purpose: { push } }));
      if (!table) continue;
      const t = this.out<TryTable>(table);
      const byItem = new Map<ItemId, TryRow[]>();
      const unmatched: TryRow[] = [];
      for (const row of t.rows.filter((r) => r.result === "fail")) {
        const item = this.matchPatch(row.test, patches)?.item;
        if (item) byItem.set(item, [...(byItem.get(item) ?? []), row]);
        else unmatched.push(row);
      }
      for (const [item, rows] of byItem) this.routeToAuthor(item, push, rows.map((r) => `- ${r.test} on ${r.config}: ${r.failures.join(" | ").slice(0, 300)} (tasks ${r.taskIds.join(", ")})`));
      if (unmatched.length === 0 && t.unparsed.length === 0) continue;
      const file = dataPath(this.config, this.s.id, `triage-${push}-${run}.json`);
      const triage = this.wantAgent(`triage:${push}:${run}`, "triage", "triage-try", { rev: p.rev!, goal: p.purpose || "verify the stack", tableFile: file, logsDir: artifactsDir(this.config) }, {
        purpose: { push },
        files: [{ path: file, content: JSON.stringify({ rev: p.rev, rows: unmatched, unparsed: t.unparsed }, null, 2) + "\n" }],
      });
      if (!triage) continue;
      const report = this.rep<TriageTryReport>(triage);
      for (const c of report.cells) {
        const item = c.verdict === "broken by patch" && c.patch ? this.patchBySha(c.patch)?.item : undefined;
        if (item) this.routeToAuthor(item, push, [`- ${c.test ?? c.taskId ?? "a job"}${c.config ? ` on ${c.config}` : ""}: ${c.evidence}`]);
      }
      this.itemsFromTriage(report);
    }
  }

  private routeToAuthor(item: ItemId, push: PushId, lines: string[]): void {
    this.resumeAuthor(item, `author:${item}${this.itemEpoch(item)}:try:${push}`, "try", `Try push ${this.s.pushes[push].rev} found these failures, which point at your patch:\n${lines.join("\n")}\n\nThe logs are under ${artifactsDir(this.config)}/<task id>. Fix them by amending your commit, then end with the JSON report again.`);
  }

  // -------------------------------------------------------------------------
  // 7. Meta bug

  // A patch's bug draft is only a link on its row until step 7: filing is asked once try is green.
  // Earlier versions asked right after the lint; this takes their ⚑ down.
  private earlyFileBugs(): void {
    if (at(this.s.step) >= at("meta bug")) return;
    for (const n of this.s.needsUser) if (n.key.startsWith("file-bug:")) this.clear(n.key);
  }

  private metaBug(): void {
    if (this.s.step !== "meta bug") return;
    const stacks = Object.values(this.s.stacks);
    if (!this.s.metaBug) {
      const firstDraft = Object.values(this.s.patches).find((p) => p.bugDraft)?.bugDraft;
      const draft: BugDraft = {
        product: firstDraft?.product ?? "Testing",
        component: firstDraft?.component ?? "General",
        summary: `[meta] Intermittent failures in ${this.s.folder ?? stacks.map((st) => st.folder).join(", ")}`,
        description: stacks.map((st) => st.summary ?? "").join("\n\n").trim() || this.s.text,
        bugType: "task",
        keywords: ["meta"],
      };
      this.event(this.ev("meta-bug", { bug: null, draft }));
    }
    for (const st of stacks) this.raise(`meta-bug:${st.id}`, { action: "File the meta bug, then review and submit", detail: "the meta-bug comment lists the stack in review order, with effort, value and repro", stack: st.id });
    for (const p of stacks.flatMap((st) => st.order).map((pid) => this.s.patches[pid])) {
      if (!p.bugDraft) continue;
      const key = fileBugKey(p.id);
      if (p.bug !== null) this.clear(key);
      else this.raise(key, { action: `File the bug for ${p.title.replace(/^Bug X+\s*-\s*/i, "")}`, detail: `${p.bugDraft.product}::${p.bugDraft.component}, checked by lint-text.ts`, patch: p.id, ...(p.item ? { item: p.item } : {}) });
    }
    if (!this.s.metaBug?.bug) return;
    for (const st of stacks) this.clear(`meta-bug:${st.id}`);
    const waiting = stacks.flatMap((st) => st.order).filter((pid) => /^Bug X+\b/i.test(this.s.patches[pid]?.title ?? ""));
    if (waiting.length === 0) this.setStep("submit");
  }

  // -------------------------------------------------------------------------
  // 8. Submit

  private submit(): void {
    if (this.s.step !== "submit") return;
    const e = this.stepEpoch("submit");
    let submitted = true;
    for (const st of Object.values(this.s.stacks)) {
      const patches = st.order.map((pid) => this.s.patches[pid]);
      const contentKey = shortHash(patches.map((p) => p.sha));
      if (patches.every((p) => p.revision !== undefined)) {
        this.clear(`submit:${st.id}`);
        for (const item of new Set(patches.map((p) => p.item).filter((x) => x !== undefined))) {
          if (this.s.items[item]?.state !== "waiting for review") this.setItem(item, "waiting for review");
        }
        continue;
      }
      submitted = false;
      if (this.s.kind === "burndown" && this.debugCommit()) {
        if (!this.want(`checkout:${st.id}${e}`, () => this.cli("checkout", "git", ["checkout", st.branch], { cwd: st.worktree, purpose: { stack: st.id } }))) continue;
      }
      const files = [...new Set(patches.flatMap((p) => this.patchFiles(p)))];
      const rv = this.want(`reviewers:${st.id}${e}`, () => this.cli("reviewers", "phab.ts", ["reviewers", ...files, "--repo", st.worktree], { cwd: st.worktree, purpose: { stack: st.id } }));
      if (!rv) continue;
      const reviewer = this.out<{ suggestions: ReviewerSuggestion[] }>(rv).suggestions[0]?.name;
      const missing = patches.filter((p) => !/\br=\S/.test(p.title));
      if (missing.length > 0 && reviewer) {
        const messages = missing.map((p) => ({ p, msg: this.sourceMessage(p) }));
        if (messages.some((m) => m.msg === undefined)) continue;
        const file = dataPath(this.config, this.s.id, `reviewers-${st.id}-${contentKey}.json`);
        const edits = Object.fromEntries(
          messages.map(({ p, msg }) => {
            const lines = msg!.split("\n");
            lines[0] = `${p.title.replace(/\.\s*$/, "")}, r=${reviewer}.`;
            return [p.sha, { message: lines.join("\n"), ...(p.bug !== null ? { bug: p.bug } : {}) }];
          }),
        );
        this.want(`rewrite-reviewers:${st.id}:${contentKey}`, () =>
          this.cli("rewrite", "stack.ts", ["rewrite", "--cwd", st.worktree, "--base", st.base ?? this.config.baseRef, "--branch", st.branch, "--order", patches.map((p) => p.sha).join(","), "--edits", file], {
            cwd: st.worktree,
            purpose: { stack: st.id, reason: `r=${reviewer}`, patches: Object.fromEntries(patches.map((p) => [p.sha.slice(0, 12), p.id])) },
            files: [{ path: file, content: JSON.stringify(edits) + "\n" }],
          }),
        );
        continue;
      }
      const pushes = Object.values(this.s.pushes).filter((p) => this.view.byKey.get(`dry-run:${p.id}`)?.some((j) => j.purpose.stack === st.id));
      const latestPlan = this.view.jobs.filter((j) => j.purpose.what === "plan-pushes" && j.purpose.stack === st.id).at(-1);
      const current = pushes.filter((p) => latestPlan && (this.view.byKey.get(`dry-run:${p.id}`)?.[0].startedAt ?? 0) >= latestPlan.startedAt);
      const tryFile = dataPath(this.config, this.s.id, `try-${st.id}-${contentKey}.json`);
      const check = this.want(`check:${st.id}:${contentKey}${e}`, () =>
        this.cli("check", "stack.ts", ["check", "--cwd", st.worktree, "--base", st.base ?? this.config.baseRef, "--try", tryFile], {
          cwd: st.worktree,
          purpose: { stack: st.id },
          files: [{ path: tryFile, content: JSON.stringify(current.map((p) => ({ push: p.id, complete: p.result !== undefined, result: p.result }))) + "\n" }],
        }),
      );
      if (!check) continue;
      const c = this.out<{ ok: boolean; failures: { rule: string; message: string }[] }>(check);
      if (!c.ok) {
        this.raise(`failed:${check.job}`, { action: "Pre-submit checks fail", detail: c.failures.map((f) => f.message).join("; ").slice(0, 500), job: check.job, stack: st.id });
        continue;
      }
      this.raise(`submit:${st.id}`, { action: "Review in stack-viewer, then submit", detail: `pre-submit checks pass${reviewer ? ` · reviewers: ${reviewer}` : ""}`, stack: st.id });
      // While the submit waits for you, stack.ts import picks up the Differential Revision trailers.
      const imports = this.view.jobs.filter((j) => j.purpose.what === "import-submit" && j.purpose.stack === st.id);
      const last = imports.at(-1);
      if (!last || (last.end && this.ctx.now - last.startedAt >= SUBMIT_IMPORT_MS)) {
        this.want(`import-submit:${st.id}:${imports.length}`, () =>
          this.cli("import-submit", "stack.ts", ["import", "--cwd", st.worktree, `${st.base ?? this.config.baseRef}..${st.branch}`], { cwd: st.worktree, purpose: { stack: st.id } }),
        );
      }
    }
    if (submitted && Object.keys(this.s.stacks).length > 0) this.setStep("review comments");
  }

  // The full commit message of a patch's author commit, read by the lint step.
  private sourceMessage(p: PatchView): string | undefined {
    const author = p.item ? this.authorReport(p.item) : undefined;
    const index = author?.commits.findIndex((_, i) => patchId(p.item!, i) === p.id) ?? -1;
    const msg = author && index >= 0 ? this.view.byKey.get(`msg:${p.id}:${author.commits[index]}`)?.find(succeeded) : undefined;
    return msg && this.ctx.output(msg.job);
  }

  // -------------------------------------------------------------------------
  // 9. Review comments (highest priority)

  pollDue(): boolean {
    const polls = this.view.jobs.filter((j) => j.purpose.what === "poll");
    const last = polls.at(-1);
    if (!this.ctx.presence.present || (last && !last.end)) return false;
    if (!last) return true;
    const age = this.ctx.now - last.startedAt;
    if (age >= (this.config.phabPollHours ?? 3) * HOUR) return true;
    // Coming back after a while: poll right away.
    return this.ctx.presence.since !== undefined && this.ctx.presence.since > last.startedAt && age > HOUR;
  }

  private reviewComments(): void {
    if (this.s.step !== "review comments" && this.s.step !== "landing") return;
    const revisions = Object.values(this.s.patches).filter((p) => p.revision !== undefined);
    if (revisions.length > 0 && this.pollDue()) {
      const n = this.view.jobs.filter((j) => j.purpose.what === "poll").length;
      const ds = revisions.map((p) => p.revision!).sort((a, b) => a - b);
      this.want(`poll:${n}`, () => this.cli("poll", "phab.ts", ["poll", ...ds.map((d) => `D${d}`)], { priority: REVIEW_PRIORITY }));
    }
    const lastPoll = this.view.jobs.filter((j) => j.purpose.what === "poll" && succeeded(j)).at(-1);
    for (const n of this.s.needsUser.filter((x) => x.key.startsWith("resubmit:"))) {
      // You resubmit while you're here; the next poll after the request means it's done.
      if (lastPoll && lastPoll.startedAt > (this.view.raised.get(n.key) ?? Infinity)) this.clear(n.key);
    }
    for (const p of revisions) {
      if (!p.review || !p.item) continue;
      const item = p.item;
      const reviewers = new Set(p.review.reviewers.map((r) => r.name).filter((name) => !name.startsWith("#")));
      const handled = new Set(this.view.jobs.filter((j) => j.purpose.patch === p.id && j.purpose.comments).flatMap((j) => j.purpose.comments!));
      const fresh = p.review.comments.filter((c) => !c.done && reviewers.has(c.author) && !handled.has(c.id));
      if (fresh.length > 0) {
        const h = shortHash(fresh.map((c) => String(c.id))) + this.stepEpoch("review comments");
        const cls = this.wantAgent(`classify-comments:${p.id}:${h}`, "classify-comments", "classify-review-comments", { revision: `D${p.revision}` }, { priority: REVIEW_PRIORITY, item, purpose: { patch: p.id } });
        if (!cls) continue;
        const kinds = new Map(this.rep<ClassifyReviewCommentsReport>(cls).comments.map((c) => [c.id, c]));
        const file = dataPath(this.config, this.s.id, `comments-${p.id}-${h}.json`);
        const key = `author:${item}${this.itemEpoch(item)}:address:${p.id}:${h}`;
        if (this.view.byKey.has(key)) {
          this.want(key);
          continue;
        }
        const plan = resumeAuthorPlan(this.s.id, this.view, item, "review comments", { prompt: "address-review", vars: { revision: `D${p.revision}`, commentsFile: file } }, "addressing review comments");
        if (plan === undefined || plan === "busy") continue;
        plan.purpose.patch = p.id;
        plan.purpose.comments = fresh.map((c) => c.id);
        plan.priority = REVIEW_PRIORITY;
        plan.files = [{ path: file, content: JSON.stringify(fresh.map((c) => ({ ...c, kind: kinds.get(c.id)?.kind ?? c.kind, impliesChange: kinds.get(c.id)?.impliesChange })), null, 2) + "\n" }];
        this.want(key, () => plan);
        continue;
      }
      this.afterAddress(p);
    }
  }

  // Once the author's answer is linted and reviewed: put it in the stack, interdiff, resubmit.
  private afterAddress(p: PatchView): void {
    const item = this.s.items[p.item!];
    const author = this.authorReport(item.id);
    if (!author || author.job.name !== "address-review" || item.state !== "reviewed") return;
    const st = Object.values(this.s.stacks).find((x) => x.order.includes(p.id));
    if (!st) return;
    const previous = this.authorJobs(item.id).filter((j) => succeeded(j) && j.startedAt < author.job.startedAt && commitsOf(j.name, this.rep(j)).length > 0).at(-1);
    const index = author.commits.findIndex((_, i) => patchId(item.id, i) === p.id);
    const oldSha = previous ? commitsOf(previous.name, this.rep(previous))[index] : undefined;
    const rw = this.want(`rewrite-review:${st.id}:${author.job.job}`, () =>
      this.cli("rewrite", "stack.ts", ["rewrite", "--cwd", st.worktree, "--base", st.base ?? this.config.baseRef, "--branch", st.branch, "--order", st.order.map((pid) => this.s.patches[pid].sha).join(",")], {
        cwd: st.worktree,
        priority: REVIEW_PRIORITY,
        purpose: { stack: st.id, patches: Object.fromEntries(st.order.map((pid) => [this.s.patches[pid].sha.slice(0, 12), pid])) },
      }),
    );
    if (!rw || p.worktree !== st.worktree) return;
    if (oldSha) {
      const inter = this.want(`interdiff:${p.id}:${author.job.job}`, () =>
        this.cli("interdiff", "stack.ts", ["interdiff", "--cwd", st.worktree, oldSha, p.sha], { cwd: st.worktree, priority: REVIEW_PRIORITY, purpose: { patch: p.id, stack: st.id } }),
      );
      if (!inter) return;
    }
    const replies = (this.rep<AddressReviewReport>(author.job).replies ?? []).length;
    this.raise(`resubmit:${st.id}:${author.job.job}`, {
      action: `${replies ? `Post ${replies} ${replies === 1 ? "reply" : "replies"}, then resubmit` : "Resubmit"} D${p.revision}`,
      detail: "comments addressed and re-reviewed (Opus) · interdiff below",
      stack: st.id,
      patch: p.id,
    });
    this.setItem(item.id, "waiting for review");
  }

  // -------------------------------------------------------------------------
  // 10. Landing

  private landing(): void {
    if (this.s.step !== "review comments" && this.s.step !== "landing") return;
    const patches = Object.values(this.s.patches).filter((p) => p.revision !== undefined);
    const landed = (p: PatchView) => p.review?.status === "published";
    const accepted = (p: PatchView) => {
      const active = p.review?.reviewers.filter((r) => r.status !== "resigned") ?? [];
      return active.length > 0 && active.every((r) => r.status === "accepted");
    };
    for (const item of Object.values(this.s.items)) {
      const own = patches.filter((p) => p.item === item.id);
      if (own.length > 0 && own.every(landed) && item.state !== "landed") this.setItem(item.id, "landed");
    }
    if (patches.length > 0 && patches.every(landed)) {
      this.setStep("done");
      return;
    }
    if (patches.some(accepted)) this.setStep("landing");
    if (this.s.step !== "landing") return;
    for (const st of Object.values(this.s.stacks)) {
      const ps = st.order.map((pid) => this.s.patches[pid]);
      const fresh = (p: PatchView) => p.review?.comments.some((c) => !c.done) ?? false;
      // What makes patches landable, not their order or shas: the reorder below changes those.
      const h = shortHash(ps.map((p) => `${p.id}:${accepted(p)}:${landed(p)}:${fresh(p)}`).sort()) + this.stepEpoch("landing");
      const file = dataPath(this.config, this.s.id, `landable-${st.id}-${h}.json`);
      const ord = this.want(`order-landable:${st.id}:${h}`, () =>
        this.cli("order", "stack.ts", ["order", file, "--landable"], {
          purpose: { stack: st.id },
          files: [
            {
              path: file,
              content:
                JSON.stringify({
                  patches: ps.map((p) => ({ id: p.id, effort: p.effort, value: this.s.items[p.item ?? ""]?.group.ratePerWeek, testOnly: p.testOnly, accepted: accepted(p), commentsAddressed: !fresh(p), landed: landed(p) })),
                  deps: ps.flatMap((p) => p.deps),
                  previous: st.order,
                }) + "\n",
            },
          ],
        }),
      );
      if (!ord) continue;
      const o = this.out<OrderOutput>(ord);
      if (!o.landable?.length || o.landable.every((pid) => landed(this.s.patches[pid]))) continue;
      if (o.order.join() !== st.order.join() || this.view.byKey.has(`rewrite-land:${st.id}:${h}`)) {
        const rw = this.want(`rewrite-land:${st.id}:${h}`, () =>
          this.cli("rewrite", "stack.ts", ["rewrite", "--cwd", st.worktree, "--base", st.base ?? this.config.baseRef, "--branch", st.branch, "--order", o.order.map((pid) => this.s.patches[pid].sha).join(",")], {
            cwd: st.worktree,
            purpose: { stack: st.id, patches: Object.fromEntries(ps.map((p) => [p.sha.slice(0, 12), p.id])), reason: "landing order" },
          }),
        );
        if (!rw) continue;
        if (this.out<{ conflict?: { sha: string; files: string[] } }>(rw).conflict) {
          this.raise(`failed:${rw.job}`, { action: "Conflict while moving landable patches down", detail: "stack.ts rewrite stopped on a conflict", job: rw.job, stack: st.id });
          continue;
        }
        if (o.order.join() !== st.order.join()) {
          const { id, ...rest } = st;
          this.event(this.ev("stack", { stack: id, ...rest, order: o.order }));
          continue;
        }
        const adapts = o.flippedSoftDeps.map((d, i) =>
          this.wantAgent(`adapt:${st.id}:${h}:${i}`, "adapt", "adapt-soft-dep", { patchA: this.s.patches[d.patch]?.sha ?? d.patch, patchB: this.s.patches[d.needs]?.sha ?? d.needs, reason: d.reason }, { cwd: st.worktree, purpose: { stack: st.id, patch: d.patch } }),
        );
        if (adapts.some((a) => !a)) continue;
        if (adapts.length > 0 && !this.want(`refresh:${st.id}:${h}`, () => this.cli("refresh", "stack.ts", ["import", "--cwd", st.worktree, `${st.base ?? this.config.baseRef}..${st.branch}`], { cwd: st.worktree, purpose: { stack: st.id } }))) continue;
      }
      const n = o.landable.filter((pid) => !landed(this.s.patches[pid])).length;
      this.raise(`land:${st.id}:${h}`, { action: `Reorg ready: ${n} landable ${n === 1 ? "patch" : "patches"} at the bottom`, detail: `${o.flippedSoftDeps.length} soft dependencies adapted`, stack: st.id });
    }
  }

  // Once a request is done, its worktrees go. The cwd is the main checkout: worktree.ts remove
  // kills every process under the worktree, which would include a job running inside it.
  private cleanup(): void {
    const names = new Set(
      this.view.jobs
        .filter((j) => j.purpose.what === "worktree" && succeeded(j))
        .map((j) => this.out<{ name: string }>(j).name),
    );
    for (const name of names) {
      this.want(`remove:${name}`, () => this.cli("remove", "worktree.ts", ["remove", name], { cwd: this.config.firefoxRepo }));
    }
  }
}
