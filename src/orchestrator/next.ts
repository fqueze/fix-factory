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
import { basename, dirname, resolve } from "node:path";
import type { Annotation } from "../cli/annotations.ts";
import { describePriorArt, type PriorArtBug } from "../cli/bugzilla.ts";
import type { ClusterGroup, CollectedFailure, TryRow, TryTable } from "../cli/failures.ts";
import type { ReviewerSuggestion } from "../cli/phab.ts";
import type { ImportedCommit } from "../cli/stack/import.ts";
import type { MessageEdit } from "../cli/stack/message.ts";
import type { OrderOutput } from "../cli/stack/order.ts";
import { expectedTests, type DryRunResult, type TestRuns } from "../cli/try.ts";
import type { BugInfo, BugLandings } from "../cli/bugzilla.ts";
import { keptDir } from "../lib/kept.ts";
import { REQUEST_STEPS } from "../server/commands.ts";
import { isReviewComment, landingState } from "../state/landing.ts";
import { COMMITS_CHANGED } from "../state/flags.ts";
import { ANNOTATIONS_ITEM, lacksBug, needsMetaBug, sameBugDraft } from "../state/meta-bug.ts";
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
  PushView,
  PushId,
  RequestId,
  RequestState,
  RequestStep,
  ReviewPatchReport,
  StackView,
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
  TriageVerdict,
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
export const SUBMIT_IMPORT_SOON_MS = 20_000; // the first minutes after you copy it, while moz-phab runs
export const SUBMIT_WATCH_MS = 60 * 60_000; // after you copy the moz-phab command
export { ANNOTATIONS_ITEM };
export const LINT_ROUNDS = 2;
export const REVIEW_ROUNDS = 3;
export const STACK_REVIEW_ROUNDS = 3;
export const CANCELLED = "cancelled by you";
// Jobs with an external side effect that a failure doesn't undo: a try push can fail after mach try
// pushed (a Lando timeout), and a retry would push again. They come to you instead.
const NO_RETRY = new Set(["push"]);
const TEST_PLAN_VERSION = "v4";
// A push whose failures triage found only these passes: they aren't the stack's.
const BENIGN = new Set<TriageVerdict>(["pre-existing", "infra", "fixed"]);
// A patch whose code was accepted gets a test plan; a landed one no longer needs it.
const TEST_PLAN_STATES = new Set<ItemState>(["reviewed", "in stack", "in try", "waiting for review", "addressing review comments", "fixed"]);

// A fix of its own, not in the stack yet.
const FIXING: ItemState[] = ["fix verified locally", "in critical review", "review findings", "reviewed"];
// The cherry-pick a conflict left in progress, if there's one: a rewrite may have left none.
const ABORT_CHERRY_PICK = 'test ! -e "$(git rev-parse --git-path CHERRY_PICK_HEAD)" || git cherry-pick --abort';
const PRE_SUBMIT: ItemState[] = ["in stack", "in try"];
const STACKED: ItemState[] = ["in stack", "in try", "waiting for review", "addressing review comments", "fixed", "landed"];
export const SETTLED: ItemState[] = ["reviewed", "in stack", "in try", "waiting for review", "addressing review comments", "fixed", "landed", "left as-is", "handed back", "taken over", "waiting for a try repro"];
const WITH_PATCHES: ItemState[] = ["reviewed", "in stack", "in try", "waiting for review", "addressing review comments", "fixed", "landed"];
// Author runs that can change a patch after it was submitted (besides address-review).
const CHANGES_AFTER_SUBMIT = ["continue", "comment", "stack comments", "asked push", "try", "backout"];
export const TERMINAL: ItemState[] = ["left as-is", "handed back", "taken over", "landed", "fixed"];

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

// Not file-bug:<patch>, which earlier versions raised too early, and with the step's epoch: a
// needs-user key is raised once, and a redone step 7 asks again.
export function fileBugKey(patch: PatchId, epoch: string): string {
  return `file-bug:${patch}:meta-bug-step${epoch}`;
}

// A folder's id: within slug's 40 characters, its first parts are cut to one letter, from the left,
// so that its last ones, which tell folders apart, stay whole.
export function stackId(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1 && slug(parts.join("-")).length < parts.join("-").length; i++) {
    parts[i] = parts[i].charAt(0);
  }
  return slug(parts.join("-")) || "root";
}

// Most of their words in common: the same failure, worded with different names or numbers.
export function similarMessages(a: string, b: string): boolean {
  // The harness's wording around the failure says nothing about which failure it is.
  const core = (m: string) => m.replace(/^uncaught exception in test - /i, "").replace(/ - timed out after \d+ tries\.?$/i, "");
  const words = (m: string) => new Set(core(m).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2));
  const x = words(a);
  const y = words(b);
  const common = [...x].filter((w) => y.has(w)).length;
  return x.size > 0 && y.size > 0 && common * 4 >= Math.min(x.size, y.size) * 3;
}

// A patch event's fields from its view, to change one of them.
type Ask = { n: number; text: string }; // your nth verify-stack, and why

function patchFields(p: PatchView): Omit<PatchView, "id" | "deps" | "review" | "replyDrafts"> & { patch: PatchId } {
  const { id, deps: _d, review: _r, replyDrafts: _rd, ...rest } = p;
  return { patch: id, ...rest };
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
      return [r.runIf, r.removal].filter((sha) => sha !== undefined);
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
// The worktree's name when it was removed (its group closed, to free the disk) and not restored since: its branch was
// kept, so creating it again brings the author's commits back.
export function removedWorktree(view: View, cwd: string): string | undefined {
  const name = basename(cwd);
  const removed = view.jobs.findLast((j) => j.purpose.key === `remove:${name}` && succeeded(j));
  if (!removed) return undefined;
  const restored = view.jobs.findLast((j) => j.purpose.key.startsWith(`wt-restore:${name}:`) && succeeded(j));
  return restored && restored.startedAt > removed.startedAt ? undefined : name;
}

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
  code: string; // of their changes: a reworded commit keeps it, so its reviews and try pushes still count
  patches: { id: PatchId; source: string; item: ItemId }[];
  wt?: string;
  branch: string;
  ready: boolean; // assembled, ordered, reviewed and summarized for this hash
}

class Planner {
  readonly actions: Action[] = [];
  private readonly startedKeys = new Set<string>();
  // Pushes whose failures are all pre-existing or infra (routeTryFailures, before stackGreen reads it).
  private readonly passing = new Set<PushId>();
  private readonly raisedKeys = new Set<string>();
  private readonly itemStates = new Map<ItemId, ItemState>();
  private readonly newItems = new Map<ItemId, FailureGroup>();
  private stepSet = false;
  private readonly stackInfos = new Map<string, StackInfo>();
  private removing = false; // a burndown's skip-if removal isn't in its stack yet
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
      // Landed patches may still be backed out (their revisions reopen): watched for a few days.
      this.pollPhab();
      this.backouts();
      this.cleanup();
      this.testPlans();
      return;
    }
    // Agents read CI's profiles with profiler-cli: one too old to load them has them guess. Nothing starts
    // before the tools are checked (and updated) for the request; a failed check is a flag to retry.
    // Routing a request needs none.
    if (this.s.kind !== "unrouted" && !this.want("tools:v1", () => this.cli("tools", "tools.ts", ["update"]))) return;
    this.pruneWorktrees();
    this.computeStacks();
    this.staleFileBugs();
    this.request();
    this.firstSignal();
    this.pushes();
    this.workList();
    this.mergeSameTest();
    for (const item of Object.values(this.s.items)) this.item(item);
    // Earlier, those DEBUG commits went to try in a push of their own, which could conflict.
    for (const n of this.s.needsUser) if (n.key.startsWith("repro-conflict:")) this.clear(n.key);
    this.stacks();
    this.bugEdits();
    this.verify();
    this.askedTests();
    // Your messages to authors whose worktree is being restored.
    for (const q of this.s.queuedAuthors ?? []) this.resumeAuthor(q.item, q.key, q.reason, q.message);
    this.skipRemoval();
    this.metaDraft();
    this.metaBug();
    this.submit();
    this.submitted();
    this.reviewComments();
    this.newPatches();
    this.backouts();
    this.landing();
    this.testPlans();
  }

  // Each accepted patch's test plan for its revision: what showed the cause, the reproduction's rates, the try runs.
  // Written once the stack went through try (or the patch has a revision), again when its investigation changes or its
  // request has new try results.
  private testPlans(): void {
    const verified = at(this.s.step) >= at("meta bug");
    // Each push with results, and the commits it had (its dry run's).
    const pushes = Object.values(this.s.pushes)
      .filter((p) => p.result !== undefined)
      .map((p) => {
        const dry = this.view.byKey.get(`dry-run:${p.id}`)?.find(succeeded);
        return { push: p, commits: dry ? this.out<DryRunResult>(dry).commits : [] };
      });
    const same = (a: string, b: string) => a.startsWith(b.slice(0, 12)) || b.startsWith(a.slice(0, 12));
    for (const p of Object.values(this.s.patches)) {
      const item = p.item === undefined ? undefined : this.s.items[p.item];
      // A plan already written (shown on its row) is kept up to date whatever the step.
      if (!item || !TEST_PLAN_STATES.has(item.state) || (!verified && p.revision === undefined && p.testPlan === undefined)) continue;
      const author = item.jobs.map((j) => this.s.jobs[j]).findLast((j) => j?.name === "investigate-and-fix");
      const inv = item.investigation ?? null;
      // Only the pushes that had this patch: a plan may cite no other.
      const shas = this.s.patchShas[p.id] ?? [p.sha];
      const had = pushes.filter(({ commits }) => commits.some((c) => shas.some((x) => same(c, x))));
      // Groups this patch fixes too, their own fix dropped as covered by it.
      const alsoFixes = Object.values(this.s.items)
        .filter((i) => i.coveredBy === p.id)
        .map((i) => ({ tests: i.group.tests, failure: i.group.message, covered: i.detail, cause: i.investigation?.cause, reproduction: i.investigation?.reproduction, verification: i.investigation?.verification }));
      // Where its tests ran in each of those pushes, per job, read by the factory with fx-tests: all a plan may say about
      // try comes from them (a platform the test is skipped on, or that wasn't selected, isn't listed).
      const tests = [...new Set([...item.group.tests, ...alsoFixes.flatMap((a) => a.tests)])].filter((t) => t.includes("/")).sort();
      const runsOf = had.map(({ push }) =>
        tests.length ? this.want(`test-runs:${push.id}:${shortHash(tests).slice(0, 8)}`, () => this.cli("test-runs", "try.ts", ["test-runs", push.rev!, ...tests], { purpose: { push: push.id } })) : undefined,
      );
      if (tests.length && runsOf.some((r) => !r)) continue;
      const results = had.map(({ push, commits }, i) => ({
        purpose: push.purpose,
        rev: push.rev,
        url: push.url,
        result: push.result,
        summary: push.summary,
        thisVersion: commits.some((c) => same(c, p.sha)),
        ...(runsOf[i] ? { runs: this.out<TestRuns[]>(runsOf[i]!) } : {}),
      }));
      // The version changes with the prompt: an earlier version's session isn't resumed.
      const version = `test-plan:${p.id}:${TEST_PLAN_VERSION}:`;
      // passes-v1: plans written before told to confirm a push's runs with fx-tests --test are rewritten in their session;
      // pushes-v2: and those given every push of the request, whether it had the patch or not; positive-v1: and those
      // saying what wasn't run, or leaving out the tests it fixes too; runs-v1: and those not given the tests' runs.
      const key = `${version}${shortHash([JSON.stringify([inv, results]), "passes-v1", "pushes-v2", "positive-v1", "runs-v1", ...(alsoFixes.length ? [JSON.stringify(alsoFixes)] : [])]).slice(0, 8)}`;
      const investigationFile = dataPath(this.config, this.s.id, `test-plan-${p.id}-investigation.json`);
      const pushesFile = dataPath(this.config, this.s.id, `test-plan-${p.id}-pushes.json`);
      const notes = Object.values(inv?.files ?? {});
      const dir = author?.cwd ?? p.worktree;
      const files = [
        { path: investigationFile, content: JSON.stringify({ tests: item.group.tests, failure: item.group.message, ...inv, ...(alsoFixes.length ? { alsoFixes } : {}) }, null, 2) + "\n" },
        { path: pushesFile, content: JSON.stringify(results, null, 2) + "\n" },
      ];
      // New results go to the session that wrote it, which keeps what you asked of it.
      const last = this.view.jobs.findLast((j) => j.purpose.what === "test-plan" && j.purpose.patch === p.id && j.purpose.key.startsWith(version) && j.sessionId && succeeded(j));
      if (last) {
        this.want(key, () => ({
          purpose: { key: "", what: "test-plan", patch: p.id },
          kind: "agent",
          name: "write-test-plan",
          item: item.id,
          cwd: last.cwd,
          files,
          agent: { sessionId: last.sessionId!, resume: true, message: `Its investigation, its request's try results or your instructions changed: ${investigationFile} and ${pushesFile} are up to date. ${pushesFile} lists only the pushes that had this commit (\`thisVersion: false\`: an earlier version of it): cite no other push, and drop anything you wrote about one that isn't there. Its \`alsoFixes\`, when there, are tests it fixes too: link each on the first line with its own, with its reproduction and verification. Write nothing about what wasn't done (no platform, build type or push that wasn't run, nothing "untested" or "not confirmed"): what was run speaks for itself; only a push that still had failures in these tests is said plainly. Each push's \`runs\` are where its tests ran, per job, read with fx-tests: what you say about try (which platforms, build types, variants, how many runs, passed or failed) comes from them and nothing else, a job not listed there didn't run the test. A push with no runs of the test is left out, and nothing is said about what a tool could or couldn't show. Write the test plan again, keeping what you were asked before, then end with the JSON report.` },
        }));
        continue;
      }
      this.wantAgent(
        key,
        "test-plan",
        "write-test-plan",
        {
          sha: p.sha,
          title: p.title,
          firefoxRepo: this.config.firefoxRepo,
          investigationFile,
          files: notes.length ? notes.map((f) => `${dir}/${f}`).join(", ") : "(none written)",
          keptDir: keptDir(this.config.stateDir, basename(dir)),
          pushesFile,
        },
        { item: item.id, files, purpose: { patch: p.id } },
      );
    }
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
    // Once on Phabricator, a group doesn't go back to before its submission.
    if (PRE_SUBMIT.includes(state) && this.submittedItem(item)) return;
    this.itemStates.set(item, state);
    this.event(this.ev("item-state", { item, state, ...(detail === undefined ? {} : { detail }) }));
  }

  submittedItem(item: ItemId): boolean {
    return Object.values(this.s.patches).some((p) => p.item === item && p.revision !== undefined);
  }

  raise(key: string, fields: Omit<NeedsUser, "key" | "since">): void {
    if (this.view.raised.has(key) || this.raisedKeys.has(key)) return;
    this.raisedKeys.add(key);
    this.event(this.ev("needs-user", { key, ...fields }));
  }

  clear(key: string): void {
    if (this.s.needsUser.some((n) => n.key === key)) this.event(this.ev("user-done", { key, byFactory: true }));
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
    // You cancelled it: nothing happens until you say what to do instead (a continue or retry reopens it).
    if (last.end.error?.startsWith(CANCELLED)) {
      if (!this.view.done.has(`reopen:${last.job}`)) return undefined;
      const again = make ? make() : this.retryPlan(last);
      if (again) this.start(key, again);
      return undefined;
    }
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
      this.raise(`failed:${last.job}`, { action: `Push ${last.purpose.push} not made: the stack's code changed since its dry run. Ask the factory to plan it again (redo-step)`, detail, job: last.job });
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

  // A redone annotations group gets a fresh one: the first is as old as the request.
  private signalWorktree(): { path: string; branch: string } | undefined {
    const e = this.annotationsEpoch();
    const wt = this.want(`wt:signal${e}`, () => this.worktree(`${this.s.id}-signal${e.replaceAll("@", "-")}`));
    return wt && this.out<{ path: string; branch: string }>(wt);
  }

  // Read in the worktree the patches are written in: your checkout may be days behind.
  private skipIfs(wt: string): { a: Annotation; index: number }[] | undefined {
    const ann = this.want(`annotations${this.annotationsEpoch()}`, () => this.cli("annotations", "annotations.ts", ["list", this.s.folder ?? "", "--repo", wt], { cwd: wt }));
    if (!ann) return undefined;
    return this.out<Annotation[]>(ann)
      .map((a, index) => ({ a, index }))
      .filter((x) => x.a.kind === "skip-if");
  }

  // Redoing the annotations group later (Redo with today's skip-ifs) lists and classifies them again and plans its
  // un-skip push, without going back a step: the work list adds the push's failures when it finishes.
  private annotationsEpoch(): string {
    return `${this.stepEpoch("first signal")}${this.itemEpoch(ANNOTATIONS_ITEM)}`;
  }

  // A skip-if naming a bug, or added in an intermittent-failure bug, is a failure skip. Otherwise an agent reads the
  // history: the commit found may be a rewrite (the .ini → .toml conversion, os_version renames) of the real one.
  private classification(a: Annotation, index: number, wt: string): ClassifyAnnotationReport | undefined {
    if (a.commentBugs.length) return { kind: "flakiness", reason: `its comment names bug ${a.commentBugs.map((b) => b.id).join(", ")}`, feedback: [] };
    const bug = a.bug && "summary" in a.bug ? a.bug : undefined;
    if (bug && /^intermittent\b/i.test(bug.summary)) return { kind: "flakiness", reason: `added in bug ${bug.id} (“${bug.summary}”)`, feedback: [] };
    const r = this.wantAgent(`classify:${index}${this.annotationsEpoch()}`, "classify", "classify-annotation", {
      annotation: `${a.kind} = ${a.condition}${a.comment ? ` # ${a.comment}` : ""}`,
      manifest: `${a.manifest} [${a.test}]`,
      worktree: wt,
      commit: a.commit ? `${a.commit.sha.slice(0, 12)} (${a.commit.date.slice(0, 10)}, “${a.commit.subject}”)` : "not found",
      bug: bug ? `bug ${bug.id} (${bug.status}${bug.resolution ? ` ${bug.resolution}` : ""}, “${bug.summary}”), whose first comment is: ${bug.firstComment.slice(0, 3000)}` : a.bug ? `bug ${a.bug.id}` : "no bug",
    }, { cwd: wt, purpose: { index } });
    return r && this.rep<ClassifyAnnotationReport>(r);
  }

  private firstSignal(): void {
    if (this.s.kind !== "burndown") return;
    const redone = this.s.step !== "first signal";
    if (redone && (at(this.s.step) < at("first signal") || this.s.step === "done" || !this.itemEpoch(ANNOTATIONS_ITEM))) return;
    const setStep = (step: RequestStep) => {
      if (!redone) this.setStep(step);
    };
    const wt = this.signalWorktree();
    if (!wt) return;
    const skips = this.skipIfs(wt.path);
    if (!skips) return;
    if (skips.length === 0) {
      this.note(`No skip-if in ${this.s.folder}: the work list comes from its failures on central.`);
      setStep("work list");
      if (redone && !TERMINAL.includes(this.s.items[ANNOTATIONS_ITEM].state)) this.event(this.ev("item-state", { item: ANNOTATIONS_ITEM, state: "left as-is" }));
      return;
    }
    const classified = skips.map(({ a, index }) => {
      const c = this.classification(a, index, wt.path);
      return c && { ...a, classification: c };
    });
    if (classified.some((c) => !c)) return;
    if (!classified.some((c) => c!.classification.kind !== "unclear")) {
      this.note("Every skip-if is unclear: the work list comes from the folder's failures on central.");
      setStep("work list");
      if (redone && !TERMINAL.includes(this.s.items[ANNOTATIONS_ITEM].state)) this.event(this.ev("item-state", { item: ANNOTATIONS_ITEM, state: "left as-is" }));
      return;
    }
    if (!this.s.items[ANNOTATIONS_ITEM] && !this.newItems.has(ANNOTATIONS_ITEM)) {
      const group: FailureGroup = { message: "skip-if annotations", tests: [...new Set(skips.map((x) => x.a.manifest))], configs: [] };
      this.newItems.set(ANNOTATIONS_ITEM, group);
      this.event(this.ev("item-created", { item: ANNOTATIONS_ITEM, folder: this.s.folder ?? "", group }));
    }
    const item = this.s.items[ANNOTATIONS_ITEM];
    if (!item) return;
    // The un-skip push only needs the DEBUG commit: it doesn't wait for the run-if commit's review, only for its
    // author to be done and not to disagree with you.
    const latest = this.latestAuthor(ANNOTATIONS_ITEM);
    const authorDone = latest !== undefined && succeeded(latest) && !this.s.needsUser.some((n) => n.job === latest.job && n.key.startsWith("disagrees:"));
    if (!authorDone && !SETTLED.includes(item.state)) return;
    const debug = this.debugCommit();
    if (!debug) {
      const author = this.authorJobs(ANNOTATIONS_ITEM).filter(succeeded).at(-1);
      const why = author ? this.rep<WriteAnnotationPatchesReport>(author).summary : `the group was ${item.state}`;
      this.note(`No DEBUG commit removing flakiness skips (${why}): the work list comes from the folder's failures on central.`);
      setStep("work list");
      return;
    }
    const e = this.annotationsEpoch();
    const planned = this.planPushes(
      `plan:unskip${e}`,
      {
        goal: `reproduce the failures hidden by the flakiness skip-ifs of ${this.s.folder} that the DEBUG commit removes`,
        failuresFile: dataPath(this.config, this.s.id, "annotations.json"),
        initialPushFile: dataPath(this.config, this.s.id, "no-initial-push.json"),
        branch: wt.branch,
        worktree: wt.path,
        base: this.config.baseRef,
        since: "",
      },
      { cwd: wt.path, files: [{ path: dataPath(this.config, this.s.id, "no-initial-push.json"), content: '{"note": "none: this is the un-skip push"}\n' }] },
      (i, count) => `unskip${e.replaceAll("@", "-")}${count === 1 ? "" : `-${i + 1}`}`,
      wt.path,
    );
    if (!planned) return;
    if (planned.made.every((id) => this.s.pushes[id]?.rev)) setStep("work list");
  }

  // item: the group whose author asked for it, which waits for your approval.
  private dryRun(push: PushId, args: string[], purpose: string, cwd: string, stack?: string, item?: ItemId): DryRunResult | undefined {
    const r = this.want(`dry-run:${push}`, () => {
      // try.ts refuses a duplicate of a push still pending.
      const pending = Object.values(this.s.pushes)
        .filter((p) => p.id !== push && p.result === undefined && !p.declined)
        .flatMap((p) => {
          const d = this.view.byKey.get(`dry-run:${p.id}`)?.find(succeeded);
          return d ? [{ push: p.id, ...this.out<DryRunResult>(d) }] : [];
        })
        .map(({ push: id, tryTaskConfig, commits }) => ({ push: id, tryTaskConfig, commits }));
      const file = dataPath(this.config, this.s.id, `pending-${push}.json`);
      return this.cli("dry-run", "try.ts", ["dry-run", "--cwd", cwd, "--pending", file, "--", ...args], {
        cwd,
        files: [{ path: file, content: JSON.stringify(pending) + "\n" }],
        purpose: { push, args, cwd, purpose, ...(stack ? { stack } : {}), ...(item ? { item } : {}) },
        ...(item ? { item } : {}),
      });
    });
    return r && this.out<DryRunResult>(r);
  }

  // Plans pushes and dry-runs them. A push you declined stays out; the plan's others don't depend on it.
  private planPushes(
    key: string,
    vars: Record<string, string>,
    opts: Parameters<Planner["wantAgent"]>[4],
    idOf: (i: number, count: number) => string,
    cwd: string,
    stack?: string,
    since?: PushId,
  ): { ids: PushId[]; dry: DryRunResult[]; made: PushId[] } | undefined {
    const ids: PushId[] = [];
    const dry: DryRunResult[] = [];
    // A push you revise goes back to the agent that planned it, in its session, with what you wrote; what it returns
    // replaces that push and the plan's others still waiting for you (it returns those it keeps). Revisions of the same
    // round go together, each round once.
    const handled = new Set<PushId>();
    let revised: PushId[] | undefined;
    let replaced: PushId[] = [];
    const waiting = (id: PushId) => this.s.needsUser.some((n) => n.key === `approve-push:${id}`);
    let plan = this.wantAgent(key, "plan-pushes", "plan-try-pushes", vars, opts);
    for (let round = 0; ; round++) {
      if (!plan) return undefined;
      for (const id of replaced) if (waiting(id)) this.event(this.ev("try-declined", { push: id, text: "replaced by its planner's revision", by: "factory" }));
      const planned = this.rep<PlanTryPushesReport>(plan).pushes;
      const r = round;
      const these = planned.map((_, i) => (r === 0 ? idOf(i, planned.length) : `${idOf(0, 1)}-v${r}${planned.length === 1 ? "" : `-${i + 1}`}`));
      // Its rebuild count, when its arguments don't say it.
      const args = (push: PlanTryPushesReport["pushes"][number]) => (push.rebuild > 1 && !push.tryArgs.includes("--rebuild") ? [...push.tryArgs, "--rebuild", String(push.rebuild)] : push.tryArgs);
      const d = planned.map((push, i) => this.dryRun(these[i], args(push), push.purpose, cwd, stack, opts?.item));
      if (d.some((x) => !x)) return undefined;
      // What you judge it by: the previous push's regressions, and what claims to fix each.
      const regressions = this.rep<PlanTryPushesReport>(plan).regressions;
      these.forEach((id, i) => {
        const p = this.s.pushes[id];
        if (!p || p.scope !== undefined || p.since !== undefined) return;
        const scope = planned[i].scope;
        if (scope || (since && regressions)) this.event({ type: "try-context", request: this.s.id, push: id, ...(since && regressions ? { since, regressions } : {}), ...(scope ? { scope } : {}) });
      });
      // What it replaces: its row says what you asked and what the planner answered.
      if (revised) for (const id of these) if (this.s.pushes[id] && !this.s.pushes[id].revises) this.event({ type: "try-context", request: this.s.id, push: id, revises: revised });
      ids.push(...these);
      dry.push(...(d as DryRunResult[]));
      // A query that selected nothing goes back to its planner before you see it, once: not after its own revision.
      these.forEach((id, i) => {
        const nothing = (d[i] as DryRunResult).warnings.filter((w) => w.includes(" selected nothing: "));
        const again = (revised ?? []).some((x) => this.s.pushes[x]?.withdrawn);
        if (nothing.length && !again && waiting(id)) this.event(this.ev("try-declined", { push: id, text: `its dry run: ${nothing.join(" ")}`, replan: true, by: "factory" }));
      });
      const pending = ids.filter((p) => this.s.pushes[p]?.replan && !handled.has(p));
      if (pending.length === 0) break;
      // This round's revision, when it exists, keeps the pushes it was asked for; those revised since wait for the next.
      const asked = this.view.jobs.find((j) => j.purpose.key.startsWith(`${key}:revise:`) && j.purpose.pushes?.every((p) => pending.includes(p)))?.purpose.pushes;
      const revise = asked ?? pending;
      for (const p of revise) handled.add(p);
      revised = revise;
      replaced = ids.filter((id) => !revise.includes(id) && waiting(id));
      const prev = plan;
      const asks = revise.map((p) => `push ${p} (\`${this.s.pushes[p].command.join(" ")}\`): “${this.s.pushes[p].declined}”`).join("\n");
      const others = replaced.length ? ` The plan's other ${replaced.length === 1 ? "push" : "pushes"} still waiting for the user's approval: ${replaced.map((p) => `${p} (\`${this.s.pushes[p].command.join(" ")}\`)`).join(", ")}. What you return replaces ${replaced.length === 1 ? "it" : "them"} too: return again any that should stay as ${replaced.length === 1 ? "it is" : "they are"}.` : "";
      const message = `The user reviewed what you planned and wants it revised:\n${asks}\n\nDo exactly what they ask; a comment saying what's missing or wrong asks for it to be fixed.${vars.since}${others} Return the pushes that replace ${revise.length === 1 ? "that push" : "those pushes"}, or an empty list if they want none. Say in \`answer\` what you changed and why; if you can't do what they ask (a push only carries the commits of the branch it's made from), say so and why. End with the JSON report again.`;
      const k = `${key}:revise:${shortHash(revise).slice(0, 8)}`;
      plan = this.want(k, () => ({
        purpose: { key: k, what: "plan-pushes", pushes: revise },
        kind: "agent",
        name: "plan-try-pushes",
        cwd: prev.cwd,
        agent: { sessionId: prev.sessionId!, resume: true, message },
      }));
    }
    // The ones to make: not a duplicate of a pending push, not declined.
    const made = ids.filter((id, i) => dry[i].duplicateOf === undefined && this.s.pushes[id]?.declined === undefined);
    return { ids, dry, made };
  }

  // -------------------------------------------------------------------------
  // Try pushes, in any step: push once approved, watch, fetch the failed jobs' artifacts.

  private pushes(): void {
    // A dry run that failed before later pushes went ahead asks nothing anymore: it becomes a note.
    for (const n of this.s.needsUser) {
      const j = n.key.startsWith("failed:") ? this.view.jobs.find((x) => x.job === n.job) : undefined;
      if (!j?.purpose.key.startsWith("dry-run:") || ![...this.view.pushedAt.values()].some((t) => t > j.startedAt)) continue;
      this.clear(n.key);
      this.note(`A try dry run failed, then later pushes went ahead: ${n.detail.slice(0, 300)}`);
    }
    for (const push of Object.values(this.s.pushes)) {
      const dry = this.view.byKey.get(`dry-run:${push.id}`)?.find(succeeded);
      if (!push.rev && !push.declined && dry && this.view.done.has(`approve-push:${push.id}`)) {
        const { args = [], cwd = this.config.firefoxRepo, stack } = dry.purpose;
        const commits = this.out<DryRunResult>(dry).commits;
        // A submitted group stays where its review is: the push is the stack's, not a step back for it.
        const items = stack ? (this.stackInfos.get(stack)?.patches.map((x) => x.item) ?? []).filter((i) => !this.submittedItem(i)) : [];
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
          this.want(`watch:${push.id}`, () => this.watch(push.id, ["--lando", String(o.landoJobId)]));
        }
        continue;
      }
      if (push.rev && push.result === undefined) {
        this.want(`watch:${push.id}`, () => this.watch(push.id, [push.rev!]));
      }
    }
    for (const f of this.view.tryFailures) {
      if (f.retryId === undefined) continue;
      this.want(`artifacts:${f.taskId}:${f.retryId}`, () =>
        this.cli("artifacts", "artifacts.ts", ["fetch", f.taskId, "--run", String(f.retryId), "--into", `${artifactsDir(this.config)}/${f.taskId}`], { purpose: { push: f.push } }),
      );
    }
  }

  // With the test tasks its dry run asks for, so its progress counts those.
  private watch(push: PushId, target: string[]): JobPlan {
    const dry = this.view.byKey.get(`dry-run:${push}`)?.find(succeeded);
    const expect = dry && expectedTests(this.out<DryRunResult>(dry));
    const file = dataPath(this.config, this.s.id, `expect-${push}.json`);
    return this.cli("watch", "try.ts", ["watch", ...target, ...(expect ? ["--expect", file] : [])], {
      kind: "try-watch",
      purpose: { push },
      ...(expect ? { files: [{ path: file, content: JSON.stringify(expect) + "\n" }] } : {}),
    });
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
    // Once half the test tasks asked for have finished (Treeherder's job count, before the watch knew them), or
    // after 2 h: a slow pool doesn't hold up what the others found.
    const done = p.progress?.tests ?? p.progress;
    const early = (done !== undefined && done.total > 0 && done.done * 2 >= done.total) || (pushedAt !== undefined && this.ctx.now - pushedAt >= EARLY_WORK_LIST_MS);
    if (earlyStarted || (p.result === undefined && early)) runs.push(`early${e}`);
    if (p.result) runs.push(`final${e}`);
    return runs;
  }

  // -------------------------------------------------------------------------
  // 3. Work list

  private signalPushes(): PushId[] {
    // A declined un-skip push gives no signal: the work list then comes from the folder's history.
    return Object.keys(this.s.pushes).filter((id) => (id === "initial" || id.startsWith("unskip")) && this.s.pushes[id].declined === undefined);
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
    // A single's test that already has an item or is in a group is investigated there. Earlier
    // versions also sent singles to merge-clusters, which folded some into groups.
    const withSingles = (gs: FailureGroup[]) => {
      const covered = new Set([...this.knownTests(), ...gs.flatMap((g) => g.tests)]);
      return [...gs, ...singles.filter((g) => !g.tests.some((t) => covered.has(t))).map(strip)];
    };
    if (groups.length <= 1) return withSingles(groups.map(strip));
    const clustersFile = dataPath(this.config, this.s.id, `clusters-${scope}-${run}.json`);
    const merge = this.wantAgent(`merge:${scope}:${run}`, "merge", "merge-clusters", { clustersFile, logsDir: artifactsDir(this.config) }, { files: [{ path: clustersFile, content: JSON.stringify({ groups }, null, 2) + "\n" }] });
    if (!merge) return undefined;
    const byKey = new Map(groups.map((g) => [g.key, g]));
    const merged = this.rep<MergeClustersReport>(merge).groups.map((g) => {
      // Where it failed comes from the clusters it merges, never from the agent: one gave every group the folder's
      // configs, and cluster keys that matched none. Those then come from the clusters of its tests.
      const named = g.from.map((k) => byKey.get(k)).filter((x) => x !== undefined);
      const sharing = groups.filter((x) => x.tests.some((t) => g.tests.includes(t)));
      const alike = sharing.filter((x) => similarMessages(x.message, g.message));
      const sources = named.length ? named : alike.length ? alike : sharing;
      const rates = sources.map((x) => x.ratePerWeek).filter((x) => x !== undefined);
      const taskIds = [...new Set(sources.flatMap((x) => x.taskIds ?? []))];
      return {
        message: g.message,
        tests: g.tests,
        configs: [...new Set(sources.flatMap((x) => x.configs))].sort(),
        ...(rates.length ? { ratePerWeek: Math.round(rates.reduce((a, b) => a + b, 0) * 10) / 10 } : {}),
        ...(taskIds.length ? { taskIds } : {}),
      };
    });
    return withSingles(merged);
  }

  private knownTests(): Set<string> {
    return new Set([...Object.values(this.s.items).flatMap((i) => i.group.tests), ...[...this.newItems.values()].flatMap((g) => g.tests)]);
  }

  // A later run finds the groups of the earlier ones again, possibly with more tests: a group is
  // known when one of its tests already has an item with its message. Not the message alone:
  // singles of different tests share generic messages such as "Test timed out". A merged group's messages are
  // " | "-separated.
  private createItems(groups: FailureGroup[]): void {
    const pair = (message: string, test: string) => `${message}\n${test}`;
    const known = new Set([...Object.values(this.s.items).map((i) => i.group), ...this.newItems.values()].flatMap((g) => g.message.split(" | ").flatMap((m) => g.tests.map((t) => pair(m, t)))));
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
  // Failures already on central are only noted, unless you asked for them to be fixed too: a group each, from the
  // triage of any of its pushes, and the request goes back to fixing (the stack, its push and its submission
  // follow as before).
  private askedTests(): void {
    if (!this.s.askedTests?.length || this.s.step === "done") return;
    const tests = this.knownTests();
    let created = false;
    for (const j of this.view.jobs.filter((x) => x.name === "triage-try" && succeeded(x))) {
      for (const c of this.rep<TriageTryReport>(j).cells) {
        if (!c.test || tests.has(c.test) || !this.s.askedTests.some((t) => c.test!.endsWith(t) || t.endsWith(c.test!))) continue;
        tests.add(c.test);
        created = true;
        this.createItem({ message: c.evidence.slice(0, 300), tests: [c.test], configs: c.config ? [c.config] : [], ...(c.taskId ? { taskIds: [c.taskId] } : {}) });
      }
    }
    // Once on Phabricator, the request stays where it is: their patches go on top of the stack (newPatches).
    const submitted = Object.values(this.s.patches).some((p) => p.revision !== undefined);
    if (created && !submitted && at(this.s.step) > at("investigate and fix")) this.setStep("investigate and fix");
  }

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

  // Round limits count from the author's latest fresh start, address-review run or continue from you:
  // review comments and your message begin a new conversation with the critical reviewer.
  private roundsSinceStart(item: ItemId, reason: string): number {
    const jobs = this.authorJobs(item);
    const start = jobs.findLastIndex((j) => j.purpose.reason === "initial" || j.purpose.reason === "start" || j.purpose.reason === "continue" || j.name === "address-review");
    return jobs.slice(start + 1).filter((j) => j.purpose.reason === reason).length;
  }

  resumeAuthor(item: ItemId, key: string, reason: string, message: string, state: ItemState = "investigating"): JobRecord | undefined {
    if (this.view.byKey.has(key)) return this.want(key);
    // A removed worktree comes back first.
    const session = this.authorJobs(item).filter((j) => j.purpose.reason === "initial" || j.purpose.reason === "start").at(-1);
    const removed = session && removedWorktree(this.view, session.cwd);
    if (removed) {
      const removal = this.view.jobs.findLast((j) => j.purpose.key === `remove:${removed}`)!;
      // On its kept branch, as it was: no --base.
      this.want(`wt-restore:${removed}:${removal.job}:v2`, () => ({ ...this.worktree(removed, { item }), cli: { tool: "worktree.ts", args: ["create", removed, "--build", "artifact"] } }));
      return undefined;
    }
    // Its own commit has no Differential Revision line (the stack's has): without the revision it can't read the reviews.
    const revs = Object.values(this.s.patches).filter((p) => p.item === item && p.revision !== undefined);
    if (revs.length) {
      const list = revs.map((p) => `D${p.revision} (https://phabricator.services.mozilla.com/D${p.revision})`).join(", ");
      message = `Your patch is on Phabricator as ${list}: read its reviews with the read-phabricator-comments skill. Your own commit doesn't carry its Differential Revision line; the factory keeps it in the stack.\n\n${message}`;
    }
    const plan = resumeAuthorPlan(this.s.id, this.view, item, reason, { message }, state);
    return plan === "busy" || plan === undefined ? undefined : this.want(key, () => plan);
  }

  // One group per test: its first failure usually causes the others. A group whose author hasn't started joins the
  // first open group of its test; if that one's author started, it's told about the new failures once its run ends.
  // A first group already in the stack keeps it waiting for that fix (item()).
  private mergeSameTest(): void {
    const started = (i: ItemView) => this.authorJobs(i.id).length > 0 || i.id === ANNOTATIONS_ITEM;
    // Some groups name their test by file name alone: the full path another group gives it.
    const paths = new Map(Object.values(this.s.items).flatMap((i) => i.group.tests.filter((t) => t.includes("/")).map((t) => [basename(t), t] as const)));
    const testOf = (i: ItemView) => (i.group.tests[0].includes("/") ? i.group.tests[0] : (paths.get(i.group.tests[0]) ?? i.group.tests[0]));
    const into = new Map<string, ItemView>();
    for (const i of Object.values(this.s.items)) {
      if (TERMINAL.includes(i.state)) continue;
      const test = testOf(i);
      const first = into.get(test);
      if (!first) {
        into.set(test, i);
        continue;
      }
      if (started(i) || STACKED.includes(first.state)) continue;
      this.merge(i, first, started(first), `merged into the first group of ${basename(test)}`);
    }
    // A group only waiting for its DEBUG commits to go to try, when another group of its test has a fix: that fix may
    // well cover it, and its author checks.
    for (const i of Object.values(this.s.items)) {
      if (i.state !== "waiting for a try repro" || i.id === ANNOTATIONS_ITEM) continue;
      const fixed = Object.values(this.s.items).find((x) => x.id !== i.id && testOf(x) === testOf(i) && FIXING.includes(x.state));
      if (fixed) this.merge(i, fixed, true, `another group of ${basename(i.group.tests[0])} has a fix: its author checks whether it covers this failure`);
    }
  }

  // Its failures join `into`'s; told: `into`'s author started, and hears about the new ones once its run ends.
  private merge(i: ItemView, into: ItemView, told: boolean, why: string): void {
    const g = into.group;
    const known = g.message.split(" | ").includes(i.group.message);
    const group = {
      ...g,
      ...(told && !known ? { late: [...(g.late ?? []), i.group.message] } : {}),
      message: known ? g.message : `${g.message} | ${i.group.message}`,
      configs: [...new Set([...g.configs, ...i.group.configs])],
      taskIds: g.taskIds || i.group.taskIds ? [...new Set([...(g.taskIds ?? []), ...(i.group.taskIds ?? [])])] : undefined,
    };
    this.event(this.ev("item-group", { item: into.id, group }));
    into.group = group;
    this.event(this.ev("item-state", { item: i.id, state: "left as-is", detail: why }));
    i.state = "left as-is";
    this.clear(`take-it:${i.id}`);
  }

  private item(item: ItemView): void {
    if (TERMINAL.includes(item.state)) return;
    const e = this.itemEpoch(item.id);
    const prefix = `author:${item.id}${e}`;
    if (item.id === ANNOTATIONS_ITEM) {
      const wt = this.signalWorktree();
      if (!wt) return;
      const input = this.view.byKey.has(`${prefix}:initial`) ? [] : this.annotationsInput(wt.path);
      if (!input) return;
      this.want(`${prefix}:initial`, () =>
        this.agent("author", "write-annotation-patches", { folder: this.s.folder ?? "", annotations: dataPath(this.config, this.s.id, "annotations.json") }, {
          key: `${prefix}:initial`,
          item: item.id,
          cwd: wt.path,
          purpose: { item: item.id, reason: "initial" },
          files: [{ path: dataPath(this.config, this.s.id, "annotations.json"), content: JSON.stringify(input, null, 2) + "\n" }],
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
        // Groups failing the same test ask once, as the first of them, whichever's verdict found someone.
        const first = Object.values(this.s.items).find((i) => i.group.tests[0] === test)!;
        const key = `take-it:${first.id}`;
        // Earlier versions asked once per group.
        if (first.id !== item.id) this.clear(`take-it:${item.id}`);
        const bug = this.out<{ bugs: PriorArtBug[] }>(prior).bugs.find((b) => b.id === v.bug);
        this.raise(key, { action: `Someone else may be fixing ${basename(test)}`, detail: bug ? describePriorArt(bug) : v.quote.slice(0, 500), item: first.id });
        if (!this.view.done.has(key)) return;
      }
      // Groups failing the same test go one at a time: the first one's fix often fixes the others' failures too.
      const all = Object.values(this.s.items);
      const earlier = all.slice(0, all.indexOf(item)).filter((i) => i.group.tests[0] === test);
      // Each worktree is ~6 GB: a request has no more than it can run agents in, the others wait for one to close.
      if (!this.view.byKey.has(`wt:${item.id}${e}`)) {
        if (earlier.some((i) => !SETTLED.includes(i.state))) return;
        // Groups being investigated in a worktree: reviewed ones keep theirs, but no agent runs in it; the disk
        // check in worktree.ts covers those.
        const open = Object.values(this.s.items).filter((i) => i.id !== item.id && !SETTLED.includes(i.state) && this.view.byKey.get(`wt:${i.id}${this.itemEpoch(i.id)}`)?.some((j) => !j.end || succeeded(j)));
        const planned = [...this.startedKeys].filter((k) => k.startsWith("wt:i-")).length;
        if (open.length + planned >= (this.config.maxWorktrees ?? this.config.maxAgents)) return;
      }
      const wt = this.want(`wt:${item.id}${e}`, () => this.worktree(`${this.s.id}-${item.id}${e.replace("@", "-")}`, { item: item.id }));
      if (!wt) return;
      const path = this.out<{ path: string }>(wt).path;
      const groupFile = dataPath(this.config, this.s.id, `items/${item.id}${e}.json`);
      const rate = item.group.ratePerWeek === undefined ? "" : `, ${item.group.ratePerWeek} failures/week`;
      const reuse = v.verdict === "reuse" && v.bug ? ` Bug ${v.bug} is already open for it: use it in the commit message.` : "";
      const tests = item.group.tests.length > 1 ? `${test} (and ${item.group.tests.length - 1} other tests)` : test;
      const fixed = earlier.filter((i) => WITH_PATCHES.includes(i.state)).map((i) => this.authorReport(i.id)?.job);
      const before = fixed.length
        ? ` This test already has a fix for another failure (${fixed.map((j) => `"${this.s.items[j!.item!].group.message}": the commits beyond origin/main in ${j!.cwd}`).join("; ")}). First check whether it fixes this failure too; if it does, change nothing and report "left as-is", saying so.`
        : "";
      this.want(`${prefix}:initial`, () =>
        this.agent(
          "author",
          "investigate-and-fix",
          { test: tests, worktree: path, failureSummary: `"${item.group.message}" on ${item.group.configs.length} configs${rate}; the full group, with its configs and task ids, is in ${groupFile}.${reuse}${before}` },
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
    // Groups of its test merged in after it started.
    if (item.group.late?.length) {
      const key = `${prefix}:late:${shortHash(item.group.late).slice(0, 8)}`;
      if (!this.view.byKey.has(key)) {
        this.resumeAuthor(item.id, key, "same test", `The same test also failed with: ${item.group.late.map((m) => `"${m}"`).join(", ")} (the test's failures are now on ${item.group.configs.join(", ")}; task ids ${item.group.taskIds?.join(", ") ?? "unknown"}). Check whether your fix covers these too; if not, fix them as well, amending your commit or adding one. Then end with the JSON report again.`);
        return;
      }
    }
    const author = this.authorReport(item.id)!;
    if (this.askedPush(item, author.job)) return;
    // Skips whose tests still fail: leaving those failures unfixed is your call.
    if (item.id === ANNOTATIONS_ITEM) {
      const keep = this.rep<WriteAnnotationPatchesReport>(author.job).keepSkips;
      for (const n of this.s.needsUser) if (n.key.startsWith("keep-skips:") && n.job !== author.job.job) this.clear(n.key);
      if (keep?.length) {
        this.raise(`keep-skips:${author.job.job}`, { action: `Keep ${keep.length === 1 ? "this skip-if" : `these ${keep.length} skip-ifs`}? Their tests still fail on try`, detail: keep.map((k) => `${k.skip}: ${k.failure}`).join("\n").slice(0, 1500), job: author.job.job, item: item.id });
        return;
      }
    }
    if (author.commits.length === 0) return;
    // A ⚑ on its author's last run (it disagrees with you, it fixed without reproducing…): nothing goes on until you
    // answer.
    if (this.s.needsUser.some((n) => n.job === author.job.job && (n.key.startsWith("disagrees:") || n.key.startsWith("failed:")))) return;
    this.checkAndReview(item, author.job, author.commits);
  }

  // Undefined until every skip-if is listed and classified: a redone group exists before they are.
  // A try push its author asked for (it never pushes): planned from what it asked, approved by you, then the author
  // is resumed with the results, before any critical review: one would only ask for that verification.
  // No try push for one fix: the stack goes to try as a whole, with the DEBUG commits of authors that need CI
  // evidence. Only the skip-ifs group's, an address-review's (a reviewer asked) and one asked by an author you've
  // been talking to are made.
  private askedPush(item: ItemView, author: JobRecord): boolean {
    const asked = this.rep<{ tryRequest?: string }>(author).tryRequest;
    if (!asked) return false;
    const e = this.itemEpoch(item.id);
    const own = `${item.id.replace(/^i-/, "").slice(0, 24)}-ask-`;
    const declineOwn = (text: string) => {
      for (const p of Object.values(this.s.pushes)) {
        if (p.id.startsWith(own) && !p.rev && p.declined === undefined) this.event(this.ev("try-declined", { push: p.id, text, by: "factory" }));
      }
    };
    // Once on Phabricator, its change is reviewed (its interdiff yours to see) before any push, and what its author
    // asked for goes to try with the whole stack: the other new patches too.
    const submitted = Object.values(this.s.patches).filter((p) => p.item === item.id && p.revision !== undefined);
    if (submitted.length) {
      declineOwn("not from its worktree: its patch is on Phabricator, so the stack goes to try as a whole, once this change is reviewed");
      if (this.s.items[item.id].state === "waiting for review") {
        const text = `Its author asked for this after changing ${submitted.map((p) => `D${p.revision}`).join(", ")} (${shortHash([author.job]).slice(0, 4)}): ${asked}`;
        if (!(this.s.verifyAsked ?? []).includes(text)) this.event(this.ev("verify-asked", { text }));
      }
      return false;
    }
    if (item.id !== ANNOTATIONS_ITEM && author.name !== "address-review" && !this.authorJobs(item.id).some((j) => j.purpose.reason === "continue")) {
      declineOwn("not needed anymore: the stack goes to try as a whole");
      // Told once already: what it reported stands.
      if (this.rep<{ commits: string[] }>(author).commits.length || author.purpose.reason === "no push of its own") return false;
      this.resumeAuthor(
        item.id,
        `author:${item.id}${e}:no-push:${author.job}`,
        "no push of its own",
        "The factory makes no try push for one fix: the stack goes to try as a whole. If you need evidence only CI can give, commit \"DEBUG -\" logging (and widening) and report \"needs a try repro\": it goes in the next try push. Otherwise end with what you have (a fix and its evidence, or \"not reproduced\" or \"blocked\" and why). End with the JSON report again, without a tryRequest.",
      );
      return true;
    }
    // The skip-ifs group works in the signal worktree.
    const wt = this.view.byKey.get(item.id === ANNOTATIONS_ITEM ? `wt:signal${this.annotationsEpoch()}` : `wt:${item.id}${e}`)?.find(succeeded);
    if (!wt) return false;
    const { path, branch } = this.out<{ path: string; branch: string }>(wt);
    const h = shortHash([author.job]).slice(0, 4);
    const groupFile = dataPath(this.config, this.s.id, `items/${item.id}${e}.json`);
    const none = dataPath(this.config, this.s.id, "no-initial-push.json");
    const planned = this.planPushes(
      `plan:asked:${item.id}${e}:${author.job}`,
      { goal: `what the author of ${item.group.tests[0]} asked for: ${asked}`, failuresFile: groupFile, initialPushFile: none, branch, worktree: path, base: this.config.baseRef, since: "" },
      { cwd: path, item: item.id, purpose: { item: item.id }, files: [{ path: none, content: '{"note": "none"}\n' }] },
      (i, count) => `${item.id.replace(/^i-/, "").slice(0, 24)}-ask-${h}${count === 1 ? "" : `-${i + 1}`}`,
      path,
    );
    if (!planned) return true;
    if (planned.made.some((id) => this.s.pushes[id]?.result === undefined)) return true;
    const results = this.pushResults(planned.made);
    const declined = planned.ids.map((id) => this.s.pushes[id]?.declined).filter((t) => t !== undefined && t !== "discarded");
    const message = planned.made.length
      ? `The try push you asked for ran: ${results}. Read the results with fx-tests (\`fx-tests try <rev>\`, with \`--all-jobs\` for the tests that failed then passed on retry inside a green job); the failed jobs' logs are under ${artifactsDir(this.config)}/<task id>. Act on them, then end with the JSON report again, without a tryRequest unless you need another push.`
      : `The user didn't make the try push you asked for${declined.length ? `: “${declined[0]}”` : ""}. Go on without it, then end with the JSON report again, without a tryRequest.`;
    this.resumeAuthor(item.id, `author:${item.id}${e}:asked:${author.job}`, "asked push", message);
    return true;
  }

  private annotationsInput(wt: string): unknown[] | undefined {
    const skips = this.skipIfs(wt);
    const input = skips?.map(({ a, index }) => {
      const c = this.classification(a, index, wt);
      return c && { manifest: a.manifest, test: a.test, condition: a.condition, line: a.line, comment: a.comment, kind: c.kind, reason: c.reason };
    });
    // Nothing to write when every skip-if is unclear (firstSignal then closes the group).
    return input?.every((x) => x) && input.some((x) => x!.kind !== "unclear") ? input : undefined;
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
    // Only annotation patches go under the meta bug: any other needs a bug of its own, an open one or a draft.
    const bugless = patches.filter((p) => this.s.patches[p.id] && lacksBug(this.s.patches[p.id]));
    if (bugless.length && item.id !== ANNOTATIONS_ITEM && author.purpose.reason !== "bug") {
      this.resumeAuthor(
        item.id,
        `author:${item.id}${e}:bug:${author.job}`,
        "bug",
        `${bugless.length === 1 ? `Your commit ${bugless[0].sha.slice(0, 12)} has` : `Your commits ${bugless.map((p) => p.sha.slice(0, 12)).join(", ")} have`} no bug: only annotation patches go under the meta bug. If an open bug covers this failure, put its number in the commit message; otherwise add a draft for each one to \`bugDrafts\` in your report, for the user to file (keep \`Bug XXXXXXX\`): separate fixes get separate bugs. Change nothing else, then end with the JSON report again.`,
      );
      return;
    }
    // A bug an author names can't be FIXED (often the bug that added the skip-if being removed: not this failure's) nor a
    // DUPLICATE (the bug it duplicates is the one); an inactive one closed otherwise (INCOMPLETE…) can be reopened. The one
    // you gave stands; a submitted patch keeps its revision's.
    const named = patches.map((p) => this.s.patches[p.id]).filter((pv) => pv !== undefined && pv.bug !== null && !pv.bugFromYou && pv.revision === undefined);
    const checks = named.map((pv) => this.want(`bug-check:${pv.bug}`, () => this.cli("bug-check", "bugzilla.ts", ["bug", String(pv.bug)], { item: item.id, priority, purpose: { item: item.id } })));
    if (checks.some((c) => !c)) return;
    const resolved = named.map((pv, i) => ({ pv, bug: this.out<BugInfo>(checks[i]!) })).filter((x) => ["FIXED", "DUPLICATE"].includes(x.bug.resolution));
    if (resolved.length) {
      const list = resolved.map((x) => `bug ${x.bug.id} (“${x.bug.summary}”, ${x.bug.status} ${x.bug.resolution})`).join(", ");
      // Told once; named again, you decide.
      if (author.purpose.reason === "bug") {
        for (const x of resolved) this.raise(`bug-resolved:${x.pv.id}`, { action: `Its commit is under a bug already fixed`, detail: `${x.pv.title}: ${list}. Tell its author which open bug to use, or to draft a new one.`.slice(0, 500), patch: x.pv.id, item: item.id });
      } else {
        this.resumeAuthor(item.id, `author:${item.id}${e}:bug-resolved:${author.job}`, "bug", `Your commit names ${list}, which is already fixed (or a duplicate): it isn't this failure's bug, and a fix can't land under it. Put the number of a bug that covers this failure in the commit message (an open one, or one closed as INCOMPLETE or WORKSFORME, which can be reopened; for a duplicate, the bug it duplicates), or add a draft to \`bugDrafts\` in your report and keep \`Bug XXXXXXX\`. Change nothing else, then end with the JSON report again.`);
      }
      return;
    }
    // Closed otherwise: you reopen it before it lands.
    named.forEach((pv, i) => {
      const bug = this.out<BugInfo>(checks[i]!);
      if (!["RESOLVED", "VERIFIED", "CLOSED"].includes(bug.status)) return;
      this.raise(`reopen-bug:${bug.id}`, { action: `Reopen bug ${bug.id}`, detail: `“${bug.summary}” is ${bug.status} ${bug.resolution}, and ${pv.title.replace(/,\s*r=.*$/, "")} lands under it`.slice(0, 500), patch: pv.id, item: item.id });
    });
    const lints: { job: JobRecord; what: string }[] = [];
    let pending = false;
    for (const p of patches) {
      const msg = this.want(`msg:${p.id}:${p.sha}`, () => this.cli("msg", "git", ["log", "-1", "--format=%B", p.sha], { cwd, item: item.id, priority, purpose: { item: item.id, patch: p.id } }));
      const lint = msg && this.want(`lint:${p.id}:${p.sha}`, () => this.cli("lint", "lint-text.ts", ["--kind", "commit", outPath(this.config, msg.job)], { item: item.id, priority, purpose: { item: item.id, patch: p.id } }));
      if (lint) lints.push({ job: lint, what: `the commit message of ${p.sha.slice(0, 12)}` });
      else pending = true;
    }
    const report = this.rep<InvestigateReport & AddressReviewReport>(author);
    // Each patch's bug draft, as its author wrote it.
    const drafts = author.name === "investigate-and-fix" ? (report.bugDrafts ?? (report.bugDraft ? [{ commits: [], draft: report.bugDraft }] : [])) : [];
    drafts.forEach((d, i) => {
      const patch = Object.values(this.s.patches).find((p) => p.item === item.id && p.bug === null && p.bugDraft && (d.commits.length === 0 || d.commits.some((x) => p.sha.startsWith(x) || x.startsWith(p.sha.slice(0, 12)))));
      if (!patch) return;
      const file = dataPath(this.config, this.s.id, `drafts/${author.job}${i ? `-${i}` : ""}.json`);
      const lint = this.want(`lint-bug:${author.job}${i ? `:${i}` : ""}`, () =>
        this.cli("lint", "lint-text.ts", ["--kind", "bug", file], { item: item.id, files: [{ path: file, content: JSON.stringify(d.draft) + "\n" }], purpose: { item: item.id, patch: patch.id } }),
      );
      if (lint) lints.push({ job: lint, what: drafts.length > 1 ? `the bug draft “${d.draft.summary}”` : "the bug draft" });
      else pending = true;
    });
    {
      for (const reply of report.replies ?? []) {
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
    const reviewed = () => {
      if (!WITH_PATCHES.includes(item.state) || item.state === "addressing review comments") this.setItem(item.id, "reviewed");
    };
    // The skip-if removal is the commit try verified, reworded: the lint is all it needs.
    if (item.id === ANNOTATIONS_ITEM && this.rep<WriteAnnotationPatchesReport>(author).removal) {
      reviewed();
      return;
    }
    // The nits pass, and any lint fixes after it, only get the lint again: no new critical review.
    const jobs = this.authorJobs(item.id);
    if (jobs.slice(0, jobs.indexOf(author) + 1).findLast((j) => j.purpose.reason !== "lint")?.purpose.reason === "nits") {
      reviewed();
      return;
    }
    // Only reworded (a bug added, a message fixed): the code an earlier review accepted needs no new one.
    if (this.acceptedCode(item.id, author)) {
      reviewed();
      return;
    }
    // The same commits a critical review already found problems in: another review would say the same. You decide.
    const prior = patches.map((p) => this.view.jobs.filter((j) => j.purpose.what === "review" && j.purpose.patch === p.id && j.purpose.sha === p.sha && j.purpose.key !== `review:${p.id}:${author.job}` && succeeded(j)).at(-1));
    if (!this.view.byKey.has(`review:${patches[0].id}:${author.job}`) && prior.every((j) => j && this.rep<ReviewPatchReport>(j).verdict === "findings")) {
      const last = prior.at(-1)!.job;
      if (this.view.done.has(`failed:${last}`)) return;
      // Into the stack all the same: the question waits for you on its row without holding the stack back.
      this.raise(`failed:${last}`, { action: "Its author left the patch unchanged after the critical review", detail: report.summary.slice(0, 500), job: last, item: item.id });
      reviewed();
      return;
    }
    // An answer to review comments is reviewed against them: a change claimed but not made is caught here.
    const answered = author.name === "address-review" ? (author.purpose.comments ?? []) : [];
    const reviews = patches.map((p) => {
      const comments = (this.s.patches[p.id]?.review?.comments ?? []).filter((c) => answered.includes(c.id));
      const file = dataPath(this.config, this.s.id, `review-comments-${p.id}-${author.job}.json`);
      const vars = { sha: p.sha, worktree: cwd, report: reportPath(this.config, this.s.id, author.job), comments: comments.length ? ` It answers the review comments in ${file}: check each one is really dealt with as its reviewer asked, in the code or in a reply in the report; a change the report claims but the diff doesn't make is a must-fix.` : "" };
      return this.wantAgent(`review:${p.id}:${author.job}`, "review", "review-patch", vars, {
        cwd,
        priority,
        item: item.id,
        ...(comments.length ? { files: [{ path: file, content: JSON.stringify(comments, null, 2) + "\n" }] } : {}),
        purpose: { item: item.id, patch: p.id, sha: p.sha },
        startEvents: [this.ev("item-state", { item: item.id, state: "in critical review" })],
      });
    });
    if (reviews.some((r) => !r)) return;
    const findings = reviews.flatMap((r) => {
      const rep = this.rep<ReviewPatchReport>(r!);
      return rep.verdict === "findings" ? rep.findings.map((f) => ({ ...f, job: r! })) : [];
    });
    if (findings.length === 0) {
      reviewed();
      return;
    }
    const list = findings.map((f) => `- [${f.severity}]${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""} ${f.text}`).join("\n");
    // Nits alone get one author pass that isn't a round: counting them used up REVIEW_ROUNDS.
    const mustFix = findings.filter((f) => f.severity === "must-fix");
    if (mustFix.length === 0) {
      this.resumeAuthor(item.id, `author:${item.id}${e}:nits:${author.job}`, "nits", `A critical reviewer left these nits on your patch:\n${list}\n\nThey're nits: address each one by amending your commit, or say in one line in the report's summary why not. Then end with the JSON report again.`, "review findings");
      return;
    }
    const key = `author:${item.id}${e}:review:${author.job}`;
    const rounds = this.roundsSinceStart(item.id, "review");
    if (rounds >= REVIEW_ROUNDS && !this.view.byKey.has(key)) {
      const last = mustFix[0].job.job;
      // You answered its ⚑ (accept-review, or a recovery plan's set-state): your call stands.
      if (this.view.done.has(`failed:${last}`)) {
        return;
      }
      // The patch goes on into the stack: its findings wait for you on its row, as a reviewer's comments would,
      // without holding the stack (and its try push, which may be what they ask for) back.
      this.raise(`failed:${last}`, { action: `No ok after ${REVIEW_ROUNDS} critical review rounds`, detail: mustFix.map((f) => f.text).join("; ").slice(0, 500), job: last, item: item.id });
      reviewed();
      return;
    }
    this.resumeAuthor(item.id, key, "review", `A critical reviewer found these problems in your patch:\n${list}\n\nAddress them by amending your commit, then end with the JSON report again. Must-fix findings have to be fixed; where you disagree with one, say why in the report's summary. For nits, address them or say in one line why not.`, "review findings");
  }

  // -------------------------------------------------------------------------
  // 4b. Try repro: an author that needs CI evidence commits DEBUG logging and waits; its commits go to try on top of
  // the stack (tryBranch), and it gets the results (reproResults).

  // -------------------------------------------------------------------------
  // 5. Stack, per folder once every item in it is settled

  // A burndown's groups make one stack for its folder, subfolders included; other requests, one per folder.
  // One stack per request: one try push verifies it, one meta bug tracks it. A burndown's is its folder's; stacks
  // made per test folder before keep their patches only once submitted (liveStacks).
  private stackFolder(i: ItemView): string {
    const f = this.s.kind === "burndown" ? this.s.folder : undefined;
    if (f === undefined) return this.s.folder ?? "";
    return i.folder === f || i.folder.startsWith(`${f}/`) ? f : i.folder;
  }

  // Its stacks, but those of a burndown's subfolders made before it got one stack for its whole folder: their
  // patches are in that one.
  private liveStacks(): StackView[] {
    const current = new Set(Object.values(this.s.items).map((i) => this.stackFolder(i)));
    return Object.values(this.s.stacks).filter((st) => current.has(st.folder) || st.order.some((p) => this.s.patches[p]?.revision !== undefined));
  }

  private computeStacks(): void {
    const folders = [...new Set(Object.values(this.s.items).map((i) => this.stackFolder(i)))].sort();
    // A stack of the earlier rule (one per test folder) is dropped, unless it was submitted: its patches stay in it.
    const old = Object.values(this.s.stacks).filter((st) => !folders.includes(st.folder));
    const submitted = (st: StackView) => st.order.some((p) => this.s.patches[p]?.revision !== undefined);
    for (const st of old.filter((st) => !submitted(st))) {
      this.event(this.ev("stack-dropped", { stack: st.id }));
      delete this.s.stacks[st.id];
      // Its worktree goes too (the request's end would remove it), unless a job still runs in it.
      const wt = this.view.byKey.get(`wt:${st.id}`)?.find(succeeded);
      if (wt && !this.view.jobs.some((r) => r.end === undefined && r.cwd.startsWith(st.worktree))) {
        const { name } = this.out<{ name: string }>(wt);
        this.want(`remove:${name}`, () => this.cli("remove", "worktree.ts", ["remove", name], { cwd: this.config.firefoxRepo }));
      }
    }
    const submittedElsewhere = new Set(old.filter(submitted).flatMap((st) => st.order));
    const ids = new Map<string, string>();
    for (const folder of folders) {
      // A stack keeps the id it was made with; two folders whose ids are the same don't share one.
      let id = Object.values(this.s.stacks).find((st) => st.folder === folder)?.id ?? stackId(folder);
      if (ids.has(id)) id = `${id.slice(0, 33)}-${shortHash([folder]).slice(0, 6)}`;
      ids.set(id, folder);
      const items = Object.values(this.s.items).filter((i) => this.stackFolder(i) === folder);
      if (items.some((i) => !SETTLED.includes(i.state))) continue;
      const patches: StackInfo["patches"] = [];
      for (const item of items) {
        if (!WITH_PATCHES.includes(item.state)) continue;
        const author = this.authorReport(item.id);
        author?.commits.forEach((source, i) => {
          if (this.s.patches[patchId(item.id, i)] && !submittedElsewhere.has(patchId(item.id, i))) patches.push({ id: patchId(item.id, i), source, item: item.id });
        });
      }
      if (patches.length === 0) continue;
      const wtJob = this.view.byKey.get(`wt:${id}`)?.find(succeeded);
      const hash = this.assembled(id, shortHash(patches.map((p) => `${p.id}=${p.source}`)) + this.stepEpoch("stack"));
      const code = shortHash(patches.map((p) => `${p.id}=${this.codeOf(p.id) ?? p.source}`)) + this.stepEpoch("stack");
      const info: StackInfo = { id, folder, hash, code, patches, branch: `${this.s.id}-${id}`, ready: false };
      if (wtJob) info.wt = this.out<{ path: string }>(wtJob).path;
      info.ready = this.view.byKey.get(`summary:${id}:${hash}`)?.some(succeeded) ?? false;
      this.stackInfos.set(id, info);
    }
  }

  // A stack coming back to patches it had before (a group taken over, a patch dropped) is assembled again: its
  // branch was rewritten since that assembly. Each return to them is a generation of their hash ("-2", "-3"…).
  private assembled(id: string, hash: string): string {
    const runs: string[] = [];
    for (const j of this.view.jobs) {
      const m = j.purpose.key.match(new RegExp(`^assemble:${id}:([^:]+)$`));
      if (m && m[1] !== runs.at(-1)) runs.push(m[1]);
    }
    const base = (h: string) => h.replace(/-\d+$/, "");
    const last = runs.at(-1);
    if (last !== undefined && base(last) === hash) return last;
    const before = new Set(runs.filter((h) => base(h) === hash)).size;
    return before === 0 ? hash : `${hash}-${before + 1}`;
  }

  private stacks(): void {
    const step = at(this.s.step);
    // At the meta bug, a burndown's stack may still get its skip-if removal; until it's submitted, its order may change.
    const submitted = Object.values(this.s.patches).some((p) => p.revision !== undefined);
    if (step < at("investigate and fix") || step > at(submitted ? "meta bug" : "submit")) return;
    for (const info of this.stackInfos.values()) this.buildStack(info);
    const items = Object.values(this.s.items);
    if (!items.some((i) => i.state === "waiting for a try repro") || items.some((i) => WITH_PATCHES.includes(i.state))) this.clear("repro-only");
    if (this.s.step === "investigate and fix" && this.newItems.size === 0 && items.every((i) => SETTLED.includes(i.state))) {
      const repro = items.filter((i) => i.state === "waiting for a try repro");
      if (items.every((i) => !WITH_PATCHES.includes(i.state)) && repro.length) {
        // DEBUG commits go to try on top of the stack: without one, nothing carries them.
        this.raise("repro-only", { action: "Only DEBUG commits are left, and no stack to push them with", detail: `${repro.map((i) => basename(i.group.tests[0])).join(", ")}: tell the factory whether to push them anyway, or close these groups.` });
      } else if (items.every((i) => !WITH_PATCHES.includes(i.state))) {
        this.note("Every item ended without a patch.");
        this.setStep("done");
      } else {
        this.setStep("stack");
      }
    }
    if (this.s.step === "stack" && this.stackInfos.size > 0 && [...this.stackInfos.values()].every((i) => i.ready)) this.setStep("verify on try");
  }

  private buildStack(info: StackInfo): void {
    const { id, hash, code } = info;
    // The ⚑s of an earlier version of this stack (its patches changed since) ask nothing anymore.
    for (const n of this.s.needsUser) {
      const job = n.job === undefined ? undefined : this.view.jobs.find((j) => j.job === n.job);
      // Only the jobs keyed by the stack's hash or code: effort, sync, reviewers… have keys of their own.
      const versioned = job?.purpose.stack === id && new RegExp(`^(assemble|deps|order|reorder|resolve|review-stack|summary|plan:verify):${id}:[0-9a-f]{10}`).test(job.purpose.key);
      if (versioned && !job.purpose.key.includes(`:${hash}`) && !job.purpose.key.includes(`:${code}`)) this.clear(n.key);
    }
    if (!this.want(`wt:${id}`, () => this.worktree(info.branch))) return;
    const wt = info.wt!;
    const prev = this.s.stacks[id];
    const bySource = new Map(info.patches.map((p) => [p.source, p]));
    // Keep the previous order across reassemblies, new patches last.
    const sources = [
      ...(prev?.order ?? []).map((pid) => info.patches.find((p) => p.id === pid)?.source).filter((x) => x !== undefined),
      ...info.patches.filter((p) => !prev?.order.includes(p.id)).map((p) => p.source),
    ];
    // Authors may report short shas; the stack scripts answer with full ones.
    const sourceOf = (sha: string) => bySource.get(sha) ?? info.patches.find((p) => sha.startsWith(p.source) || p.source.startsWith(sha))!;
    const patchesOf = (shas: string[]) => Object.fromEntries(shas.map((sha) => [sha.slice(0, 12), sourceOf(sha).id]));
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
      // What it fixes is fixed already (by an earlier patch of the stack, or on the base): the cherry-pick left in
      // progress goes, and its author keeps only what isn't covered yet, or ends with nothing left ("left as-is").
      // The stack is assembled again with what it returns.
      if (r.state === "already fixed") {
        if (!this.want(`abort:${res.job}:v2`, () => this.cli("abort", "sh", ["-c", ABORT_CHERRY_PICK], { cwd: wt, purpose: { stack: id } }))) return;
        const item = sourceOf(conflict.sha).item;
        this.resumeAuthor(
          item,
          `author:${item}${this.itemEpoch(item)}:covered:${res.job}`,
          "covered",
          `Assembling the stack, your commit ${conflict.sha.slice(0, 12)} conflicted with a change that already does what it does: ${r.explanation}\n\nThat commit is in this repository (\`git show\` it). Rebase your commits on top of it and keep only what it doesn't already do (each part you keep has to be needed on its own). If nothing is left, drop your commits and report "left as-is", with that commit's sha in \`coveredBy\`. Then end with the JSON report again.`,
        );
        return;
      }
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
    // Authors may report short shas; the stack scripts answer with full ones.
    const among = (set: Set<string>, sha: string) => [...set].some((x) => x.startsWith(sha) || sha.startsWith(x));
    if (!cur || sources.some((sha) => !among(mapped, sha))) return;
    // A change already in the base, or made by another patch of the stack, makes no commit: that patch is left out,
    // and its author keeps only what isn't covered, or drops it ("left as-is", naming what covers it).
    for (const p of info.patches.filter((x) => among(empty, x.source))) {
      this.resumeAuthor(
        p.item,
        `author:${p.item}${this.itemEpoch(p.item)}:empty:${p.source.slice(0, 12)}`,
        "covered",
        `Assembling the stack, your commit ${p.source.slice(0, 12)} made no change: the stack's other patches (on branch ${info.branch}) or the base already do what it does. Find which commit does (\`git log -p ${this.config.baseRef}..${info.branch}\` in this repository), then keep only what it doesn't already do (each part you keep has to be needed on its own), or, if nothing is left, drop your commits and report "left as-is", with that commit's sha in \`coveredBy\`. Then end with the JSON report again.`,
      );
    }
    const kept = info.patches.filter((p) => !among(empty, p.source));
    const inStack = kept.filter((p) => this.s.patches[p.id].worktree === wt);
    if (inStack.length < kept.length) return; // the handlers' patch events haven't landed yet
    const shaToPatch = Object.fromEntries(inStack.map((p) => [this.s.patches[p.id].sha.slice(0, 12), p.id]));
    const deps = this.want(`deps:${id}:${hash}`, () => this.cli("deps", "stack.ts", ["deps", "--cwd", wt, "--base", this.config.baseRef], { cwd: wt, purpose: { stack: id, patches: shaToPatch } }));
    // Skip-if annotation changes take the least review: a few manifest lines that try showed safe.
    const unrated = inStack.map((p) => this.s.patches[p.id]).filter((pv) => pv.item === ANNOTATIONS_ITEM && pv.effort !== 0);
    for (const pv of unrated) this.event(this.ev("patch", { ...patchFields(pv), effort: 0 }));
    if (unrated.length) return;
    const efforts = inStack.filter((p) => this.s.patches[p.id].item !== ANNOTATIONS_ITEM).map((p) =>
      this.wantAgent(`effort:${p.id}:${this.codeOf(p.id) ?? p.source}`, "effort", "estimate-review-effort", { sha: this.s.patches[p.id].sha, worktree: wt }, { cwd: wt, purpose: { patch: p.id, stack: id } }),
    );
    if (!deps || efforts.some((x) => !x)) return;
    const value = (pid: PatchId) => this.s.items[this.s.patches[pid].item ?? ""]?.group.ratePerWeek;
    const orderInput = {
      patches: inStack.map((p) => {
        const pv = this.s.patches[p.id];
        // A landed patch stays in the stack until the base has it: landable, as far as its order goes.
        const { landed: _l, ...landing } = landingState(this.s, pv);
        return { id: p.id, effort: pv.effort, value: value(p.id), testOnly: pv.testOnly, ...landing };
      }),
      deps: inStack.flatMap((p) => this.s.patches[p.id].deps).map((d) => ({ ...d, needs: this.depTarget(d.needs, inStack.map((x) => x.id)) })),
    };
    // Ordered again when what it's ordered by changes (an effort, a dep, how the factory ranks them).
    const oh = shortHash([JSON.stringify(orderInput)]).slice(0, 6);
    const orderFile = dataPath(this.config, this.s.id, `order-${id}-${hash}-${oh}.json`);
    const ord = this.want(`order:${id}:${hash}:${oh}`, () =>
      this.cli("order", "stack.ts", ["order", orderFile], {
        purpose: { stack: id },
        files: [
          {
            path: orderFile,
            content:
              JSON.stringify({ ...orderInput, previous: prev?.order }) + "\n",
          },
        ],
      }),
    );
    if (!ord) return;
    const order = this.out<OrderOutput>(ord).order;
    const assembled = sources.map((sha) => bySource.get(sha)!.id).filter((pid) => order.includes(pid));
    if (order.join() !== assembled.join()) {
      const re = this.want(`reorder:${id}:${hash}:${oh}`, () =>
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
    // Reviewed again when its order changes (a dep the last review added): it reviews the stack as ordered.
    const review = this.wantAgent(`review-stack:${id}:${code}:${shortHash(order).slice(0, 6)}`, "review-stack", "review-stack", { base: this.config.baseRef, branch: info.branch, worktree: wt, depsFile }, {
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
    // An earlier version counted every review of the stack, whatever they were about.
    this.clear(`failed:${review.job}`);
    if (mustFix.length > 0) {
      const byItem = new Map<ItemId, string[]>();
      for (const f of mustFix) {
        const p = this.patchBySha(f.patch);
        const item = p?.item ?? inStack[0].item;
        byItem.set(item, [...(byItem.get(item) ?? []), `- ${p ? `${p.title}: ` : ""}${f.text}`]);
      }
      for (const [item, lines] of byItem) {
        // An author that already answered stack reviews of its patch this many times, and is still flagged, comes to
        // you on its group's row, where you can tell it what to do or close it.
        const asked = this.view.jobs.filter((j) => j.item === item && j.purpose.key.startsWith(`author:${item}${this.itemEpoch(item)}:stack-review:`) && j.end).length;
        if (asked >= STACK_REVIEW_ROUNDS) {
          this.raise(`stack-review:${item}:${review.job}`, { action: `The stack review still flags its patch after ${asked} rounds with its author`, detail: lines.join("\n").slice(0, 1000), job: review.job, item });
          continue;
        }
        this.resumeAuthor(
          item,
          `author:${item}${this.itemEpoch(item)}:stack-review:${review.job}`,
          "stack review",
          `The review of the whole stack found problems with your patch:\n${lines.join("\n")}\n\nAddress them by amending your commit. If another patch of the stack already does what yours does, drop your commits and report "left as-is", with that commit's sha in \`coveredBy\`. Then end with the JSON report again.`,
        );
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
    for (const stack of this.liveStacks()) {
      const info = this.stackInfos.get(stack.id);
      if (at(this.s.step) <= at("verify on try") && !info?.ready) continue;
      const edits: Record<PatchId, number> = {};
      for (const pid of stack.order) {
        const p = this.s.patches[pid];
        if (!p || !/^Bug X+\b/i.test(p.title)) continue;
        const bug = p.bug ?? (meta !== null && p.item === ANNOTATIONS_ITEM ? meta : null);
        if (bug !== null) edits[pid] = bug;
      }
      if (Object.keys(edits).length === 0) continue;
      const key = `rewrite-bugs:${stack.id}:${shortHash(Object.entries(edits).map(([k, v]) => `${k}=${v}:${this.s.patches[k].sha}`))}`;
      const e = this.rewriteEdits(`${stack.id}-${shortHash([key])}`, stack.order.map((pid) => this.s.patches[pid]), Object.fromEntries(Object.entries(edits).map(([pid, bug]) => [this.s.patches[pid].sha, { bug }])));
      this.want(key, () =>
        this.cli("rewrite", "stack.ts", ["rewrite", "--cwd", stack.worktree, "--base", stack.base ?? this.config.baseRef, "--branch", stack.branch, "--order", stack.order.map((pid) => this.s.patches[pid].sha).join(","), ...e.args], {
          cwd: stack.worktree,
          purpose: { stack: stack.id, edits, patches: Object.fromEntries(stack.order.map((pid) => [this.s.patches[pid].sha.slice(0, 12), pid])) },
          files: e.files,
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 6. Verify on try

  // Its author commit's patch-id, from the import of its author's commits (none from before patch-ids).
  private codeOf(pid: PatchId): string | undefined {
    const p = this.s.patches[pid];
    const author = p.item ? this.authorReport(p.item) : undefined;
    const imp = author && this.view.byKey.get(`import:${author.job.job}`)?.find(succeeded);
    if (!imp) return undefined;
    const index = author.commits.findIndex((_, i) => patchId(p.item!, i) === p.id);
    return this.out<ImportedCommit[]>(imp)[index]?.patchId || undefined;
  }

  // A dep's "needs" as a patch of the stack when its text names one (agents name commits by any sha they've had, or by
  // title): an author's "lands after 8f68f1ae2fde (…) Bug XXXXXXX - Reposition popups…" is a hard dep on that patch.
  private depTarget(needs: string, ids: PatchId[]): string {
    if (ids.includes(needs)) return needs;
    const patches = ids.map((id) => this.s.patches[id]);
    const shas = needs.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
    const bySha = patches.find((p) => [p.sha, ...(p.pastShas ?? [])].some((x) => shas.some((s) => x.startsWith(s))));
    const byTitle = patches.find((p) => needs.includes(p.title.replace(/^Bug (\d+|X+) - /i, "").replace(/,? r=.*$/, "")));
    return (bySha ?? byTitle)?.id ?? needs;
  }

  // Whether an earlier run of this item's authors had the same code (git patch-id) as this one, and its code was
  // accepted: its critical reviews passed, or only nits were left, which its nits pass addressed.
  private acceptedCode(item: ItemId, author: JobRecord): boolean {
    const codes = (j: JobRecord) => {
      const imp = this.view.byKey.get(`import:${j.job}`)?.find(succeeded);
      return imp && this.out<ImportedCommit[]>(imp).map((c) => c.patchId);
    };
    const mine = codes(author);
    if (!mine?.every(Boolean)) return false;
    const jobs = this.authorJobs(item).filter(succeeded);
    for (const prev of jobs.slice(0, jobs.indexOf(author)).reverse()) {
      const theirs = codes(prev);
      if (!theirs || theirs.join() !== mine.join()) return false;
      if (prev.purpose.reason === "nits") return true;
      const reviews = this.view.jobs.filter((j) => j.purpose.what === "review" && j.purpose.key.endsWith(`:${prev.job}`) && succeeded(j));
      if (reviews.length) return reviews.every((r) => this.rep<ReviewPatchReport>(r).verdict === "ok");
    }
    return false;
  }

  // A file an author named, relative to its worktree: readable from anywhere.
  private authorFile(author: JobRecord, file: string | undefined): string | undefined {
    return file === undefined ? undefined : resolve(author.cwd, file);
  }

  private patchFiles(p: PatchView): string[] {
    if (!p.item) return [];
    const author = this.authorReport(p.item);
    const imp = author && this.view.byKey.get(`import:${author.job.job}`)?.find(succeeded);
    if (!imp) return [];
    const index = author.commits.findIndex((_, i) => patchId(p.item!, i) === p.id);
    return this.out<ImportedCommit[]>(imp)[index]?.files ?? [];
  }

  // A failure in a test a patch touches, or in that patch's folder, goes to that patch's author.
  // A test the patch changes, or one its group fixes. Not the folder: a burndown's patches share one, and every
  // failure in it would go to its first patch's author.
  matchPatch(test: string, patches: PatchView[]): PatchView | undefined {
    return patches.find((p) => this.patchFiles(p).includes(test) || (p.item !== undefined && this.s.items[p.item]?.group.tests.includes(test)));
  }

  // Verified by the current plan's pushes; with none to make (you declined them, or the planner found the earlier ones
  // enough), by the stack's pushes already made, which must exist and be green.
  private stackGreen(info: StackInfo, made: PushId[]): boolean {
    const pushes = made.length ? made : this.madePushes(info.id);
    if (!pushes.length) this.raise(`unverified:${info.id}`, { action: "Nothing verifies this stack on try", detail: "every planned push was declined, and none was made before: tell the factory what to do", stack: info.id });
    else this.clear(`unverified:${info.id}`);
    return pushes.length > 0 && pushes.every((push) => this.s.pushes[push]?.result === "green" || this.passing.has(push));
  }

  private madePushes(stack: string): PushId[] {
    return Object.values(this.s.pushes).filter((p) => p.rev && this.view.byKey.get(`dry-run:${p.id}`)?.[0].purpose.stack === stack).map((p) => p.id);
  }

  // The ids of the verification pushes of the stack's current code.
  private verifyPrefix(info: StackInfo, ask?: Ask): string {
    // The DEBUG commits on top are part of what's pushed (none: the same ids as before them).
    const debug = this.debugGroups().flatMap((g) => g.commits);
    if (ask) return `${info.id}-ask${ask.n}-${shortHash([info.code, ...debug]).slice(0, 4)}`;
    return `${info.id}-${shortHash([info.code, this.stepEpoch("verify on try"), ...debug]).slice(0, 4)}`;
  }

  // The current plan's pushes (ids) and those to make (made).
  private verifyPushes(info: StackInfo, ask?: Ask): { ids: PushId[]; made: PushId[] } | undefined {
    const e = this.stepEpoch("verify on try");
    const stack = this.s.stacks[info.id];
    if (!stack || !info.wt) return undefined;
    const top = this.tryBranch(info, stack.branch, e);
    if (!top) return undefined;
    const branch = top.branch;
    const failuresFile = dataPath(this.config, this.s.id, `failures-${info.id}.json`);
    const initialFile = dataPath(this.config, this.s.id, "initial-pushes.json");
    const debug = this.debugGroups().flatMap((g) => g.commits);
    const planKey = `plan:verify:${info.id}:${info.code}${e}${ask ? `:ask${ask.n}` : ""}${debug.length ? `:${shortHash(debug).slice(0, 6)}` : ""}`;
    // After an earlier push of the stack: what changed since, and what it claims to fix, before planning the next.
    // Only a new plan waits for it; the current plan's own pushes aren't earlier ones.
    const since = this.sinceLastPush(info, ask);
    if (since === null && !this.view.byKey.has(planKey)) return undefined;
    const planned = this.planPushes(planKey, {
      goal: `verify the fixes of the ${info.folder ? `${info.folder} ` : ""}stack: every failure below should be gone, with no new one${ask ? `. The user asked for this push: “${ask.text}”` : ""}`,
      failuresFile,
      initialPushFile: initialFile,
      branch,
      worktree: info.wt,
      base: stack.base ?? this.config.baseRef,
      since: since && since !== null
        ? ` The stack was pushed before (${since.rev}: ${since.summary}). What changed since, each changed patch with its interdiff and what its author said it fixes, and that push's failures, are in ${since.file}. Return \`regressions\`: each failure of that push the stack caused (not pre-existing, not infra), in one line, with the patch that broke it (\`causedBy\`), its \`status\`, and how: for "fixed", the patch whose change since then fixes it (\`fixedBy\`, its id), judged from its interdiff, not only its author's word; "patch removed" when the patch that caused it left the stack; "pre-existing" only when central shows the same failure. A regression nothing fixes isn't worth a push: plan none for it, and say so in its \`how\`.`
        : "",
    }, {
      cwd: info.wt,
      purpose: { stack: info.id },
      files: [
        {
          path: failuresFile,
          content:
            JSON.stringify(
              [
                ...info.patches.map((p) => ({ patch: p.id, title: this.s.patches[p.id].title, ...this.s.items[p.item].group })),
                // Not fixed yet: DEBUG commits on top of the stack log (and widen) these failures, to reproduce them.
                ...this.debugGroups()
                  .filter((g) => g.item.id !== ANNOTATIONS_ITEM)
                  .map((g) => ({ debugCommits: g.commits, toReproduce: true, ...g.item.group })),
              ],
              null,
              2,
            ) + "\n",
        },
        {
          path: initialFile,
          content:
            JSON.stringify(
              [
                ...this.signalPushes().map((id) => {
                  const push = this.s.pushes[id];
                  const table = this.view.byKey.get(`try-table:${id}:final`)?.find(succeeded);
                  return { push: id, purpose: push.purpose, command: push.command, rev: push.rev, result: push.result, summary: push.summary, resultsTable: table ? outPath(this.config, table.job) : undefined };
                }),
                // This stack's pushes already made: their local commits tell whether they tested the same changes.
                ...Object.values(this.s.pushes)
                  .filter((p) => p.rev && this.view.byKey.get(`dry-run:${p.id}`)?.[0].purpose.stack === info.id)
                  .map((p) => {
                    const dry = this.view.byKey.get(`dry-run:${p.id}`)!.find(succeeded)!;
                    return { push: p.id, earlierVerificationOfThisStack: true, commits: this.out<DryRunResult>(dry).commits, purpose: p.purpose, command: p.command, rev: p.rev, result: p.result ?? "running", summary: p.summary };
                  }),
              ],
              null,
              2,
            ) + "\n",
        },
        ...(since ? [{ path: since.file, content: JSON.stringify(since.content, null, 2) + "\n" }] : []),
      ],
    }, (i) => `${this.verifyPrefix(info, ask)}-${i + 1}`, info.wt, info.id, since?.push);
    return planned && { ids: planned.ids, made: planned.made };
  }

  // The stack's latest push with results, what changed since (stack.ts since: interdiffs), and what its authors were
  // told and said. undefined: no earlier push; null: still finding out.
  private sinceLastPush(info: StackInfo, ask?: Ask): { push: PushId; rev: string; summary: string; file: string; content: unknown } | null | undefined {
    const last = this.madePushes(info.id).filter((id) => this.s.pushes[id].result !== undefined && !id.startsWith(this.verifyPrefix(info, ask))).at(-1);
    if (!last || !info.wt) return undefined;
    const p = this.s.pushes[last];
    const dry = this.view.byKey.get(`dry-run:${last}`)!.find(succeeded)!;
    const patches = info.patches.map((x) => ({ id: x.id, title: this.s.patches[x.id].title, shas: [x.source, ...[...(this.s.patches[x.id].pastShas ?? [])].reverse()] }));
    const input = dataPath(this.config, this.s.id, `since-${info.id}-${last}-input.json`);
    const key = `since:${info.id}:${last}:v2:${shortHash(patches.map((x) => x.shas[0])).slice(0, 8)}`;
    const job = this.want(key, () =>
      this.cli("since", "stack.ts", ["since", "--cwd", info.wt!, input], {
        cwd: info.wt!,
        files: [{ path: input, content: JSON.stringify({ old: this.out<DryRunResult>(dry).commits, patches }, null, 2) + "\n" }],
        purpose: { stack: info.id, push: last },
      }),
    );
    if (!job) return null;
    const changes = this.s.pushChanges[info.id]?.since === last ? this.s.pushChanges[info.id] : undefined;
    if (!changes) return null;
    const pushedAt = this.view.jobs.find((j) => j.purpose.what === "push" && j.purpose.push === last)?.startedAt ?? 0;
    const table = this.view.byKey.get(`try-table:${last}:final`)?.find(succeeded);
    const content = {
      previousPush: { id: last, rev: p.rev, url: p.url, result: p.result, summary: p.summary, resultsTable: table ? outPath(this.config, table.job) : undefined, triage: p.analysis },
      changes: changes.changes.map((c) => {
        const item = this.s.patches[c.patch].item;
        // Its author's runs since that push: why each ran, and what it said.
        const runs = item === undefined ? [] : this.view.jobs.filter((j) => j.item === item && j.purpose.what === "author" && j.startedAt > pushedAt && succeeded(j));
        return {
          ...c,
          title: this.s.patches[c.patch].title,
          interdiffFile: c.interdiffFile && resolve(this.config.stateDir, c.interdiffFile),
          authorRuns: runs.map((j) => ({ why: j.purpose.reason, said: this.rep<{ summary?: string; disagreement?: string }>(j).summary, disagreement: this.rep<{ disagreement?: string }>(j).disagreement })),
        };
      }),
      removedSinceThen: changes.removed,
    };
    return { push: last, rev: p.rev!, summary: p.summary ?? p.result!, file: dataPath(this.config, this.s.id, `since-${info.id}-${last}.json`), content };
  }

  // Once the stack is verified with the DEBUG commit on top, the skips it removed whose tests passed are removed for
  // real, in a patch that lands under the meta bug; the others stay, their failures being the work list's.
  private skipRemoval(): void {
    if (this.s.kind !== "burndown" || at(this.s.step) <= at("verify on try") || this.s.step === "done" || !this.s.items[ANNOTATIONS_ITEM]) return;
    const e = this.itemEpoch(ANNOTATIONS_ITEM);
    const key = `author:${ANNOTATIONS_ITEM}${e}:removal${this.stepEpoch("verify on try")}`;
    // Once asked, its report has no DEBUG commit anymore.
    if (!this.view.byKey.has(key)) {
      const debug = this.debugCommit();
      if (!debug) return;
      const pushes = Object.values(this.s.pushes).filter((p) => p.rev && p.result && this.view.byKey.get(`dry-run:${p.id}`)?.[0].purpose.stack !== undefined);
      if (!pushes.length) return;
      // Whether a push ran artifact builds is what tells whether an `artifact` skip's config ran.
      const artifact = (p: PushView) => {
        const dry = this.view.byKey.get(`dry-run:${p.id}`)?.find(succeeded);
        return dry && this.out<DryRunResult>(dry).tryTaskConfig["use-artifact-builds"] === true ? ", artifact builds" : "";
      };
      const list = pushes.map((p) => `${p.rev} (${p.result === "green" ? "green" : (p.summary ?? "failures")}${artifact(p)})`).join(", ");
      // On top of the stack, the DEBUG commit lost the skips the fix patches remove: what's left is what try verified.
      // That commit is the patch, under a landable message; a skip whose test still failed comes back only once you
      // agree to leave that failure unfixed.
      // Its commit is first on top of the stack: in the first assembly of the latest try branch, or, if it conflicted
      // there, resolve-conflict's commit.
      let top: { head: string; branch: string } | undefined;
      let branch = "";
      for (const j of this.view.jobs.filter(succeeded)) {
        if (j.purpose.what === "try-branch") {
          const o = this.out<{ branch: string; commits?: { sha: string; newSha: string }[] }>(j);
          branch = o.branch;
          const c = o.commits?.find((c) => c.sha === debug);
          if (c) top = { head: c.newSha, branch };
        } else if (j.purpose.what === "resolve" && j.purpose.sha === debug && j.purpose.key.includes(":try-")) {
          const r = this.rep<ResolveConflictReport>(j);
          if (r.state === "resolved" && r.commit) top = { head: r.commit, branch };
        }
      }
      if (!top) return;
      const failures = pushes.some((p) => p.result !== "green")
        ? ` Some pushes had failures: read them with fx-tests (fx-tests try <rev>). For each skip your commit removes whose test failed on them in the configs the skip covered, and that no fix patch of the stack fixes, don't put it back yet: list it in \`keepSkips\` with the failure that shows it, and report without \`removal\`. The user decides whether to leave that failure unfixed; you'll be resumed with the answer.`
        : "";
      this.resumeAuthor(
        ANNOTATIONS_ITEM,
        key,
        "removal",
        `The stack was verified on try with your DEBUG commit on top: ${list}. On top of the stack it became ${top.head.slice(0, 12)} (branch ${top.branch}): it only removes the skips the fix patches don't. In your branch, replace your DEBUG commit with it (\`git rebase --onto ${debug}^ ${debug} && git cherry-pick ${top.head}\`), then reword its message to one line, no body: \`Bug XXXXXXX - Remove skip-if annotations that no longer fail in ${this.s.folder}, r=<reviewer>.\`, its reviewer from the find-reviewer skill (the bug number is the meta bug's, given later). Change no code.${failures} Otherwise report it as \`removal\` (and \`runIf\` again), without \`debug\`.`,
      );
    }
    // The meta bug waits for the removal to be in the stack: it's the patch that needs one.
    this.removing = true;
    const job = this.want(key);
    if (!job) return;
    const item = this.s.items[ANNOTATIONS_ITEM];
    // From its latest report: a review round may have amended it.
    const latest = this.rep<WriteAnnotationPatchesReport>(this.authorJobs(ANNOTATIONS_ITEM).filter(succeeded).at(-1)!);
    const removal = latest.removal;
    const info = [...this.stackInfos.values()].find((i) => i.patches.some((p) => p.source === removal));
    const pid = info?.patches.find((p) => p.source === removal)?.id;
    const inStack = info?.ready && pid !== undefined && this.s.stacks[info.id]?.order.includes(pid);
    // Ended without a patch (left as-is, handed back): the stack goes on without it.
    const asking = (latest.keepSkips?.length ?? 0) > 0 && item.state !== "handed back";
    this.removing = asking || (removal !== undefined && !inStack && !(SETTLED.includes(item.state) && !WITH_PATCHES.includes(item.state)));
  }

  // The DEBUG commits that go to try on top of the stack: the skip-ifs group's (a burndown's), then those of the
  // groups that need CI evidence (no push of their own).
  private debugGroups(): { item: ItemView; commits: string[] }[] {
    const debug = this.s.kind === "burndown" ? this.debugCommit() : undefined;
    const repro = Object.values(this.s.items)
      .filter((i) => i.state === "waiting for a try repro")
      .map((item) => ({ item, commits: this.rep<InvestigateReport>(this.authorJobs(item.id).filter(succeeded).at(-1)!).commits }));
    return [...(debug ? [{ item: this.s.items[ANNOTATIONS_ITEM], commits: [debug] }] : []), ...repro];
  }

  // Like the stack's assembly: a conflict goes to resolve-conflict, then the rest is assembled. One it can't resolve
  // (the approach doesn't fit) asks you on the group's row, and the push waits.
  private tryBranch(info: StackInfo, base: string, e: string): { branch: string } | undefined {
    const groups = this.debugGroups();
    if (!groups.length) return { branch: base };
    const shas = groups.flatMap((g) => g.commits);
    const h = shortHash([info.hash, e, ...shas]).slice(0, 6);
    const branch = `${base}-try-${h}`;
    let cur = this.want(`try-branch:${info.id}:${h}`, () =>
      this.cli("try-branch", "stack.ts", ["assemble", "--cwd", info.wt!, "--branch", branch, "--base", base, "--leave-conflict", ...shas], { cwd: info.wt, purpose: { stack: info.id } }),
    );
    while (cur) {
      const o = this.out<{ conflict?: { sha: string; files: string[] }; remaining?: string[] }>(cur);
      if (!o.conflict) return { branch };
      const { sha, files } = o.conflict;
      const owner = groups.find((g) => g.commits.includes(sha))!;
      const res = this.wantAgent(`resolve:${info.id}:try-${h}:${sha}`, "resolve", "resolve-conflict", { sha, base: branch, files: files.join(", ") }, { cwd: info.wt, purpose: { stack: info.id, sha } });
      if (!res) return undefined;
      const r = this.rep<ResolveConflictReport>(res);
      if (r.state === "already fixed") {
        if (!this.want(`abort:${res.job}`, () => this.cli("abort", "sh", ["-c", ABORT_CHERRY_PICK], { cwd: info.wt, purpose: { stack: info.id } }))) return undefined;
        this.setItem(owner.item.id, "left as-is", `already fixed: ${r.explanation}`.slice(0, 300));
        return undefined;
      }
      if (r.state !== "resolved" || !r.commit) {
        this.raise(`failed:${res.job}`, { action: "Its DEBUG commits don't apply on top of the stack", detail: r.explanation.slice(0, 500), job: res.job, item: owner.item.id });
        return undefined;
      }
      const remaining = o.remaining ?? [];
      if (!remaining.length) return { branch };
      cur = this.want(`try-branch:${info.id}:${h}:after:${sha.slice(0, 12)}`, () =>
        this.cli("try-branch", "stack.ts", ["assemble", "--cwd", info.wt!, "--branch", branch, "--leave-conflict", ...remaining], { cwd: info.wt, purpose: { stack: info.id } }),
      );
    }
    return undefined;
  }

  private debugCommit(): string | undefined {
    const author = this.authorJobs(ANNOTATIONS_ITEM).filter(succeeded).at(-1);
    return author && this.rep<WriteAnnotationPatchesReport>(author).debug;
  }

  private verify(): void {
    // Once verified, the stacks' pushes still waiting for you ask nothing anymore.
    if (at(this.s.step) > at("verify on try") && this.s.step !== "done") {
      for (const push of Object.values(this.s.pushes)) {
        const stack = this.view.byKey.get(`dry-run:${push.id}`)?.[0].purpose.stack;
        if (this.s.needsUser.some((n) => n.key === `approve-push:${push.id}`) && stack && !push.id.startsWith(`${stack}-ask`)) {
          this.event(this.ev("try-declined", { push: push.id, text: "not needed anymore: the stack was verified", by: "factory" }));
        }
      }
    }
    // Every verification push's failures are routed, also those of a stack being redone (its other authors still
    // need to hear about theirs), and those of a push that finished after the request moved on (you submitted
    // while it ran).
    if (at(this.s.step) < at("verify on try") || this.s.step === "done") return;
    for (const push of Object.values(this.s.pushes)) {
      const stack = this.view.byKey.get(`dry-run:${push.id}`)?.[0].purpose.stack;
      // Pushes made before this request (a split copies them) are evidence, routed already where they were made.
      if ((this.view.pushedAt.get(push.id) ?? Infinity) < Date.parse(this.s.createdAt)) continue;
      if (stack && this.s.stacks[stack] && push.rev) this.routeTryFailures(push.id, this.s.stacks[stack].order.map((pid) => this.s.patches[pid]));
    }
    if (this.s.step !== "verify on try") {
      this.askedVerify();
      return;
    }
    // An un-skip push may still add groups to the stack: verifying it waits for its results.
    if (this.signalPushes().some((id) => id !== "initial" && this.s.pushes[id].result === undefined)) return;
    let green = this.stackInfos.size > 0;
    for (const info of this.stackInfos.values()) {
      const plan = info.ready ? this.verifyPushes(info) : undefined;
      // Pushes still waiting for your approval that aren't in the current plan (planned for code the stack no longer
      // has, or by an earlier version of the factory) ask nothing anymore. An approved one may be being pushed.
      for (const push of Object.values(this.s.pushes)) {
        const stack = this.view.byKey.get(`dry-run:${push.id}`)?.[0].purpose.stack;
        const current = plan ? plan.ids.includes(push.id) : push.id.startsWith(`${this.verifyPrefix(info)}-`);
        if (stack === info.id && this.s.needsUser.some((n) => n.key === `approve-push:${push.id}`) && !current) {
          this.event(this.ev("try-declined", { push: push.id, text: "not needed anymore: the stack changed since it was planned", by: "factory" }));
        }
      }
      if (plan) this.reproResults(plan);
      if (!plan || !this.stackGreen(info, plan.made)) green = false;
    }
    if (green) {
      // Verified: no longer "on try".
      for (const info of this.stackInfos.values()) for (const p of info.patches) if (this.s.items[p.item]?.state === "in try") this.setItem(p.item, "in stack");
      this.setStep("meta bug");
    }
  }

  // You asked for a try push of the stack as it stands (verify-stack): planned at whatever step it's at, once per ask,
  // when its authors are done. Its failures are routed like any verification push's; the step stays.
  private askedVerify(): void {
    const n = this.s.verifyAsked?.length ?? 0;
    if (!n || at(this.s.step) <= at("verify on try")) return;
    const ask = { n, text: this.s.verifyAsked![n - 1] };
    for (const info of this.stackInfos.values()) {
      const all = `${info.id}-ask${n}-`;
      // Made, or declined by you: that ask is answered, and a later change to the stack waits for your next one. One you
      // asked to revise isn't declined: its planner revises it.
      if (Object.values(this.s.pushes).some((p) => p.id.startsWith(all) && (p.rev || (p.declined !== undefined && !p.withdrawn && !p.replan)))) continue;
      const plan = this.verifyPushes(info, ask);
      for (const push of Object.values(this.s.pushes)) {
        if (push.id.startsWith(all) && plan && !plan.ids.includes(push.id) && this.s.needsUser.some((x) => x.key === `approve-push:${push.id}`)) {
          this.event(this.ev("try-declined", { push: push.id, text: "not needed anymore: the stack changed since it was planned", by: "factory" }));
        }
      }
    }
  }

  // Each push by its full hash and summary. Green only means every job passed: a test that failed then passed on retry
  // inside its job doesn't show (fx-tests try --all-jobs finds it).
  private pushResults(ids: PushId[]): string {
    return ids.map((id) => `${this.s.pushes[id].rev} (${this.s.pushes[id].summary ?? this.s.pushes[id].result})`).join(", ");
  }

  // The authors whose DEBUG commits went to try on top of the stack get its results.
  private reproResults(plan: { ids: PushId[]; made: PushId[] }): void {
    const groups = this.debugGroups().filter((g) => g.item.id !== ANNOTATIONS_ITEM);
    const key = (g: { item: ItemView; commits: string[] }, what: string) => `author:${g.item.id}${this.itemEpoch(g.item.id)}:${what}:${shortHash([...g.commits, ...plan.ids]).slice(0, 8)}`;
    if (!plan.ids.length || plan.made.some((id) => this.s.pushes[id]?.result === undefined)) return;
    const results = this.pushResults(plan.made);
    // Pushes discarded (or withdrawn by the factory) say nothing: the DEBUG commits wait for the stack's next push.
    // Only your reason for declining one goes to them.
    const declined = plan.ids.map((id) => this.s.pushes[id]).filter((p) => p?.declined !== undefined && p.declined !== "discarded" && !p.withdrawn).map((p) => p.declined!);
    if (!plan.made.length && !declined.length) return;
    const message = plan.made.length
      ? `The factory pushed your DEBUG commits to try on top of the stack: ${results}. Read the results with fx-tests (\`fx-tests try <rev>\`, with \`--all-jobs\` for the tests that failed then passed on retry inside a green job); the failed jobs' logs are under ${artifactsDir(this.config)}/<task id>. Say in your reproduction file whether it reproduced, and how often. Then drop your DEBUG commits and fix it as usual, with the reproduction "on try"; or, if it didn't reproduce, report "not reproduced". End with the JSON report again.`
      : `The user declined the stack's try push your DEBUG commits were to go on: “${declined[0]}”. Go on from what you know: fix it if you can show the cause, or report "not reproduced". End with the JSON report again.`;
    for (const g of groups) this.resumeAuthor(g.item.id, key(g, "repro"), "repro", message);
  }

  private routeTryFailures(push: PushId, patches: PatchView[]): void {
    const p = this.s.pushes[push];
    for (const run of this.pushRuns(push, this.stepEpoch("verify on try"))) {
      const table = this.want(`try-table:${push}:${run}`, () => this.cli("try-table", "failures.ts", ["try-table", p.rev!], { purpose: { push } }));
      if (!table) continue;
      const t = this.out<TryTable>(table);
      const byItem = new Map<ItemId, TryRow[]>();
      const unmatched: TryRow[] = [];
      let rejected = false;
      // A DEBUG group's test failing is its results (reproResults), not a failure of the stack.
      // Its author may already have been resumed with the results (at the push's end, before this table was read).
      const pushedAt = this.view.pushedAt.get(push) ?? Infinity;
      const resumed = (i: ItemView) => this.authorJobs(i.id).some((j) => j.purpose.reason === "repro" && j.purpose.key.includes(":repro:") && j.startedAt >= pushedAt);
      const repro = new Set(Object.values(this.s.items).filter((i) => i.state === "waiting for a try repro" || resumed(i)).flatMap((i) => i.group.tests));
      for (const row of t.rows.filter((r) => r.result === "fail" && !repro.has(r.test))) {
        const item = this.matchPatch(row.test, patches)?.item;
        if (item) byItem.set(item, [...(byItem.get(item) ?? []), row]);
        else unmatched.push(row);
      }
      // The final run tells an author only what the early one didn't.
      const line = (r: TryRow) => `- ${r.test} on ${r.config}: ${r.failures.join(" | ").slice(0, 300)} (tasks ${r.taskIds.join(", ")})`;
      const early = run.startsWith("final") ? this.view.byKey.get(`try-table:${push}:${run.replace(/^final/, "early")}`)?.find(succeeded) : undefined;
      const told = new Set(early ? this.out<TryTable>(early).rows.filter((r) => r.result === "fail").map((r) => `${r.test} ${r.config}`) : []);
      let authorsOwn = false;
      for (const [item, rows] of byItem) {
        const fresh = rows.filter((r) => !told.has(`${r.test} ${r.config}`));
        if (fresh.length) this.routeToAuthor(item, push, fresh.map(line), early ? ":final" : "");
        // An author that says they aren't its patch's: triaged like the others.
        let disowned = false;
        for (const suffix of ["", ":final"]) {
          const r = this.view.byKey.get(`author:${item}${this.itemEpoch(item)}:try:${push}${suffix}`)?.find(succeeded);
          if (r && this.rep<{ disagreement?: string }>(r).disagreement) {
            unmatched.push(...rows.filter((x) => !unmatched.includes(x)));
            rejected = true;
            disowned = true;
          }
        }
        if (!disowned) authorsOwn = true;
      }
      // The final run passes when its only failures are pre-existing or infra: no author's to fix.
      const final = run.startsWith("final");
      if (unmatched.length === 0 && t.unparsed.length === 0) {
        if (final && !authorsOwn) this.passing.add(push);
        continue;
      }
      const file = dataPath(this.config, this.s.id, `triage-${push}-${run}.json`);
      // Rows an author handed back come after the first triage of the run: a triage of their own.
      // v2: with the stack's patches, and pre-existing only when shown on central.
      const key = rejected ? `triage:${push}:${run}:v2:${shortHash(unmatched.map((r) => `${r.test} ${r.config}`)).slice(0, 6)}` : `triage:${push}:${run}:v2`;
      const triage = this.wantAgent(key, "triage", "triage-try", { rev: p.rev!, goal: p.purpose || "verify the stack", tableFile: file, logsDir: artifactsDir(this.config) }, {
        purpose: { push },
        files: [{ path: file, content: JSON.stringify({ rev: p.rev, patches: patches.map((x) => ({ id: x.id, sha: x.sha, title: x.title, files: this.patchFiles(x) })), rows: unmatched, unparsed: t.unparsed }, null, 2) + "\n" }],
      });
      if (!triage) continue;
      const report = this.rep<TriageTryReport>(triage);
      if (final && !authorsOwn && report.cells.every((c) => BENIGN.has(c.verdict))) this.passing.add(push);
      for (const c of report.cells) {
        // By id; earlier reports gave a sha.
        const item = c.verdict === "broken by patch" && c.patch ? (this.s.patches[c.patch] ?? this.patchBySha(c.patch))?.item : undefined;
        if (item) this.routeToAuthor(item, push, [`- ${c.test ?? c.taskId ?? "a job"}${c.config ? ` on ${c.config}` : ""}: ${c.evidence}`]);
      }
      this.itemsFromTriage(report);
    }
  }

  private routeToAuthor(item: ItemId, push: PushId, lines: string[], suffix = ""): void {
    this.resumeAuthor(item, `author:${item}${this.itemEpoch(item)}:try:${push}${suffix}`, "try", `Try push ${this.s.pushes[push].rev} found these failures, which point at your patch:\n${lines.join("\n")}\n\nThe logs are under ${artifactsDir(this.config)}/<task id>. Fix them by amending your commit, then end with the JSON report again.`);
  }

  // -------------------------------------------------------------------------
  // 7. Meta bug

  // A patch's bug draft is only a link on its row until step 7: filing is asked once try is green.
  // This takes down any other file-bug ⚑: those earlier versions raised right after the lint, and
  // those of a step 7 that was redone.
  private staleFileBugs(): void {
    const epoch = this.stepEpoch("meta bug");
    for (const n of this.s.needsUser) {
      if (!n.key.startsWith("file-bug:")) continue;
      if (this.s.step !== "meta bug" || n.key !== fileBugKey(n.patch!, epoch)) this.clear(n.key);
    }
  }

  // The meta bug's text, written by an agent from the stack for its reviewers; written again when the stack or its
  // bugs change, until it's filed. One per request: a burndown has one stack.
  private metaDraft(): void {
    // A burndown's, and any other request's you asked for: its meta bug is optional.
    if ((this.s.kind !== "burndown" && !this.s.metaDraftAsked) || at(this.s.step) < at("stack") || this.s.step === "done" || this.s.metaBug?.bug) return;
    const st = this.liveStacks()[0];
    const info = st && this.stackInfos.get(st.id);
    if (!info?.ready) return;
    const ps = st.order.map((pid) => this.s.patches[pid]);
    // The prompt's version too: a better prompt writes it again.
    const h = shortHash(["v4", info.code, ...ps.map((p) => `${p.id}:${p.bug}`)]).slice(0, 10);
    const file = dataPath(this.config, this.s.id, `meta-${st.id}-${h}.json`);
    const first = ps.find((p) => p.bugDraft)?.bugDraft;
    // Fields you had its agent change stay.
    const current = this.s.metaBug?.draft;
    const blocks = current?.blocks ?? this.config.metaBugBlocks;
    const draft: BugDraft = {
      product: current?.product ?? first?.product ?? "Testing",
      component: current?.component ?? first?.component ?? "General",
      summary: current?.summary ?? (this.s.kind === "burndown" ? `[meta] Fix the flakiness in ${this.s.folder ?? st.folder}` : ""),
      description: "",
      bugType: "task",
      keywords: ["meta"],
      ...(blocks?.length ? { blocks } : {}),
    };
    const patches = ps.map((p) => {
      const item = p.item === undefined ? undefined : this.s.items[p.item];
      const inv = item?.investigation;
      return {
        sha: p.sha,
        bug: p.bug ?? (p.bugDraft ? "its own, to file" : "the meta bug"),
        title: p.title.replace(/^Bug (\d+|X+)\s*-\s*/i, "").replace(/,?\s*r[=?]\S+$/, ""),
        testOnly: p.testOnly,
        reviewEffort1to5: p.effort,
        tests: item?.group.tests,
        failure: item?.group.message,
        cause: inv?.cause,
        summary: inv?.summary ?? (item?.lastReport?.report as { summary?: string } | undefined)?.summary,
      };
    });
    const files = [{ path: file, content: JSON.stringify(patches, null, 2) + "\n" }];
    // The session that wrote it, which keeps what you asked of it.
    const last = this.view.jobs.findLast((j) => j.purpose.what === "meta-draft" && j.purpose.stack === st.id && j.sessionId && succeeded(j));
    if (last) {
      this.want(`meta-draft:${st.id}:${h}`, () => ({
        purpose: { key: "", what: "meta-draft", stack: st.id, draft },
        kind: "agent",
        name: "write-meta-bug",
        cwd: last.cwd,
        files,
        agent: { sessionId: last.sessionId!, resume: true, message: `The stack changed: ${file} has its patches now. Write the description again, keeping what the user asked of you before, then end with the JSON report again.` },
      }));
      return;
    }
    this.wantAgent(`meta-draft:${st.id}:${h}`, "meta-draft", "write-meta-bug", { ...this.metaSubject(st), stackFile: file }, { cwd: st.worktree, files, purpose: { stack: st.id, draft } });
  }

  // A burndown's meta bug is about its folder, with its dashboard; any other request's about what it asked, and its
  // agent writes the summary too.
  private metaSubject(st: StackView): Record<string, string> {
    const vars = { stackFile: "", worktree: st.worktree };
    const folder = this.s.kind === "burndown" ? (this.s.folder ?? st.folder) : undefined;
    return folder !== undefined
      ? { ...vars, subject: `the flakiness burndown of ${folder}`, overall: `what was wrong in the folder overall, the folder's path in it linking to its dashboard (\`[${folder}](https://tests.firefox.dev/tests.html?path=${folder})\`)`, summary: "" }
      : { ...vars, subject: `this request: “${this.s.text}”`, overall: "what was wrong overall", summary: " Also write its `summary`: \"[meta] \" and a few words saying what the patches fix overall (\"[meta] Fix the tests that fail when run alone\")." };
  }

  private metaBug(): void {
    if (this.s.step !== "meta bug" || this.removing) return;
    const stacks = this.liveStacks();
    const needsMeta = needsMetaBug(stacks.flatMap((st) => st.order).map((pid) => this.s.patches[pid]));
    // Filed last: it depends on every other bug of the stack, so those are filed first. A burndown's waits for its
    // agent's draft; other requests have none to wait for.
    const unfiled = stacks.flatMap((st) => st.order).some((pid) => this.s.patches[pid]?.bugDraft && this.s.patches[pid].bug === null);
    if (needsMeta && (this.s.kind !== "burndown" || this.s.metaBug?.draft) && !unfiled) for (const st of stacks) this.raise(`meta-bug:${st.id}`, { action: "File the meta bug, then review and submit", detail: "it tells reviewers what the stack fixes, patch by patch, in review order", stack: st.id });
    for (const p of stacks.flatMap((st) => st.order).map((pid) => this.s.patches[pid])) {
      if (!p.bugDraft) continue;
      const key = fileBugKey(p.id, this.stepEpoch("meta bug"));
      // Patches sharing a draft: one bug to file, asked on the first.
      if (p.bug !== null || sameBugDraft(this.s, p.id)[0].id !== p.id) this.clear(key);
      else this.raise(key, { action: `File the bug for ${p.title.replace(/^Bug X+\s*-\s*/i, "")}`, detail: `${p.bugDraft.product}::${p.bugDraft.component}, checked by lint-text.ts`, patch: p.id, ...(p.item ? { item: p.item } : {}) });
    }
    if (needsMeta && !this.s.metaBug?.bug) return;
    for (const st of stacks) this.clear(`meta-bug:${st.id}`);
    const waiting = stacks.flatMap((st) => st.order).filter((pid) => /^Bug X+\b/i.test(this.s.patches[pid]?.title ?? ""));
    if (waiting.length === 0) this.setStep("submit");
  }

  // -------------------------------------------------------------------------
  // 8. Submit

  // You may submit any time once there is a stack: its reviewers are fixed from then on, so the moz-phab command
  // works whenever you copy it. After you copy it, stack.ts import looks for the Differential Revision trailers
  // moz-phab adds, every few minutes for a while, until each patch has its revision.
  private submitted(): void {
    if (at(this.s.step) < at("stack") || this.s.step === "done") return;
    // Its reviewers are fixed once it's built; the revisions you submit are looked for whatever it's doing (verified on
    // try or not: you may submit before), after submission too (patches added on top).
    const after = at(this.s.step) > at("submit");
    for (const st of this.liveStacks()) {
      if (st.order.every((pid) => this.s.patches[pid].revision !== undefined)) continue;
      if (this.s.step !== "submit" && !after && this.stackInfos.get(st.id)?.ready) this.reviewers(st, this.stepEpoch("stack"));
      if (!st.submitCopied || this.ctx.now - Date.parse(st.submitCopied) > SUBMIT_WATCH_MS) continue;
      const imports = this.view.jobs.filter((j) => j.purpose.what === "import-submit" && j.purpose.stack === st.id);
      const last = imports.at(-1);
      const every = this.ctx.now - Date.parse(st.submitCopied) < 10 * 60_000 ? SUBMIT_IMPORT_SOON_MS : SUBMIT_IMPORT_MS;
      if (!last || (last.end && this.ctx.now - last.startedAt >= every)) {
        this.want(`import-submit:${st.id}:${imports.length}`, () =>
          this.cli("import-submit", "stack.ts", ["import", "--cwd", st.worktree, `${st.base ?? this.config.baseRef}..${st.branch}`], { cwd: st.worktree, purpose: { stack: st.id } }),
        );
      }
    }
  }

  // Every patch gets a reviewer Phabricator knows: a missing r=, or one naming someone unknown (moz-phab refuses
  // those), becomes mach's suggestion for the stack's files. The suggestion, once its r= are right.
  private reviewers(st: StackView, e: string): { reviewer?: string } | undefined {
    const patches = st.order.map((pid) => this.s.patches[pid]);
    const contentKey = shortHash(patches.map((p) => p.sha));
    // The branch first, as git has it: an author told to reword its commit may have moved it. Read again after any of
    // its authors' runs.
    const authors = shortHash([contentKey, ...patches.map((p) => (p.item ? (this.latestAuthor(p.item)?.job ?? "") : ""))]);
    if (!this.want(`sync:${st.id}:${authors}`, () => this.cli("refresh", "stack.ts", ["import", "--cwd", st.worktree, `${st.base ?? this.config.baseRef}..${st.branch}`], { cwd: st.worktree, purpose: { stack: st.id } }))) return undefined;
    const names = (p: PatchView) => /, r=([^\s,=]+(?:,\s*[^\s,=]+)*)\.$/.exec(p.title)?.[1].split(/,\s*/) ?? [];
    const all = [...new Set(patches.flatMap(names))];
    const known = all.length ? this.want(`check-reviewers:${st.id}:${shortHash(all)}`, () => this.cli("check-reviewers", "phab.ts", ["check-reviewers", ...all], { cwd: st.worktree, purpose: { stack: st.id } })) : undefined;
    if (all.length && !known) return undefined;
    const unknown = known ? this.out<{ unknown: string[] }>(known).unknown : [];
    const files = [...new Set(patches.flatMap((p) => this.patchFiles(p)))];
    const rv = this.want(`reviewers:${st.id}${e}`, () => this.cli("reviewers", "phab.ts", ["reviewers", ...files, "--repo", st.worktree], { cwd: st.worktree, purpose: { stack: st.id } }));
    if (!rv) return undefined;
    const reviewer = this.out<{ suggestions: ReviewerSuggestion[] }>(rv).suggestions[0]?.name;
    const missing = patches.filter((p) => !/\br=\S/.test(p.title) || names(p).some((n) => unknown.includes(n)) || (p.reviewerFromYou !== undefined && !names(p).includes(p.reviewerFromYou)));
    if (missing.length > 0 && reviewer) {
      // Each patch gets the suggestion for its own files (the find-reviewer skill): a stack's patches can be in
      // unrelated modules.
      const own = missing.map((p) => this.want(`reviewers:${p.id}:${p.sha}`, () => this.cli("reviewers", "phab.ts", ["reviewers", ...this.patchFiles(p), "--repo", st.worktree], { cwd: st.worktree, purpose: { stack: st.id, patch: p.id } })));
      if (own.some((j) => !j)) return undefined;
      // The first of mach's suggestions Phabricator knows, a group's rotation included (mach may still name a group
      // renamed to "#x-rotation"); the reviewer you gave first.
      const candidates = new Map(
        missing.map((p, i) => {
          const names = this.out<{ suggestions: ReviewerSuggestion[] }>(own[i]!).suggestions.map((x) => x.name);
          const all = (names.length ? names : [reviewer]).flatMap((n) => (n.startsWith("#") && !n.endsWith("-rotation") ? [n, `${n}-rotation`] : [n]));
          return [p.id, p.reviewerFromYou ? [p.reviewerFromYou] : all];
        }),
      );
      const asked = [...new Set([...candidates.values()].flat())].sort();
      const checked = this.want(`check-reviewers:${st.id}:${shortHash(asked)}`, () => this.cli("check-reviewers", "phab.ts", ["check-reviewers", ...asked], { cwd: st.worktree, purpose: { stack: st.id } }));
      if (!checked) return undefined;
      const unknownToo = new Set(this.out<{ unknown: string[] }>(checked).unknown);
      const suggested = new Map(missing.map((p) => [p.id, candidates.get(p.id)!.find((n) => !unknownToo.has(n))]));
      // None known (former reviewers, aliases): only you can pick.
      const stuck = missing.filter((p) => suggested.get(p.id) === undefined);
      for (const p of missing) {
        const key = `reviewers:${st.id}:${p.id}`;
        if (stuck.includes(p)) this.raise(key, { action: "Give a reviewer Phabricator knows", detail: `${p.title.replace(/,\s*r=.*$/, "")}: Phabricator knows none of ${candidates.get(p.id)!.join(", ")}`.slice(0, 500), stack: st.id, patch: p.id, ...(p.item ? { item: p.item } : {}) });
        else this.clear(key);
      }
      this.clear(`reviewers:${st.id}`);
      if (stuck.length) return undefined;
      const messages = missing.map((p) => ({ p, msg: this.sourceMessage(p) }));
      if (messages.some((m) => m.msg === undefined)) return undefined;
      const titles = Object.fromEntries(missing.map((p) => [p.id, `${p.title.replace(/,\s*r=.*$/, "").replace(/\.\s*$/, "")}, r=${suggested.get(p.id)}.`]));
      const edits = Object.fromEntries(
        messages.map(({ p, msg }) => {
          const lines = msg!.split("\n");
          lines[0] = titles[p.id];
          return [p.sha, { message: lines.join("\n"), ...(p.bug !== null ? { bug: p.bug } : {}) }];
        }),
      );
      const e = this.rewriteEdits(`reviewers-${st.id}-${contentKey}`, patches, edits);
      this.want(`rewrite-reviewers:${st.id}:${contentKey}`, () =>
        this.cli("rewrite", "stack.ts", ["rewrite", "--cwd", st.worktree, "--base", st.base ?? this.config.baseRef, "--branch", st.branch, "--order", patches.map((p) => p.sha).join(","), ...e.args], {
          cwd: st.worktree,
          purpose: { stack: st.id, reason: `r=${[...new Set(suggested.values())].join(", ")}`, titles, patches: Object.fromEntries(patches.map((p) => [p.sha.slice(0, 12), p.id])) },
          files: e.files,
        }),
      );
      return undefined;
    }
    return { reviewer };
  }

  private submit(): void {
    // You may submit before the factory asks you to (submitted() finds the revisions): once every patch has its
    // revision, the request goes on from the submit step, which moves it to review. Not when it has been there
    // already: a step redone after review (another try push of review fixes) runs as usual.
    const patches = this.liveStacks().flatMap((st) => st.order.map((pid) => this.s.patches[pid]));
    const early = !this.view.stepCount.get("submit") && at(this.s.step) >= at("stack") && at(this.s.step) < at("submit");
    if (early && patches.length && patches.every((p) => p.revision !== undefined)) this.setStep("submit");
    if (this.s.step !== "submit") return;
    const e = this.stepEpoch("submit");
    let submitted = true;
    for (const st of this.liveStacks()) {
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
      // Verified before this step (requests from before 2026-10-19 kept "in try").
      for (const p of patches) if (p.item && this.s.items[p.item]?.state === "in try") this.setItem(p.item, "in stack");
      // A try branch (the stack plus the DEBUG commit) was checked out in its worktree.
      if (this.view.jobs.some((j) => j.purpose.what === "try-branch" && j.purpose.stack === st.id)) {
        if (!this.want(`checkout:${st.id}${e}`, () => this.cli("checkout", "git", ["checkout", st.branch], { cwd: st.worktree, purpose: { stack: st.id } }))) continue;
      }
      const rv = this.reviewers(st, e);
      if (!rv) continue;
      const pushes = Object.values(this.s.pushes).filter((p) => this.view.byKey.get(`dry-run:${p.id}`)?.some((j) => j.purpose.stack === st.id));
      const latestPlan = this.view.jobs.filter((j) => j.purpose.what === "plan-pushes" && j.purpose.stack === st.id).at(-1);
      const planned = pushes.filter((p) => p.declined === undefined && latestPlan && (this.view.byKey.get(`dry-run:${p.id}`)?.[0].startedAt ?? 0) >= latestPlan.startedAt);
      // A latest plan with nothing left to push (declined, or none needed) left it to the pushes already made.
      const current = planned.length ? planned : pushes.filter((p) => p.rev);
      const tryFile = dataPath(this.config, this.s.id, `try-${st.id}-${contentKey}.json`);
      const tryKey = current.length ? `:${shortHash(current.map((p) => `${p.id}=${p.result ?? ""}`)).slice(0, 6)}` : "";
      const check = this.want(`check:${st.id}:${contentKey}${tryKey}${e}`, () =>
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
      // Earlier checks' failures are answered by this one.
      for (const n of this.s.needsUser) if (n.key.startsWith("failed:") && n.stack === st.id && this.view.jobs.find((j) => j.job === n.job)?.purpose.what === "check") this.clear(n.key);
      this.raise(`submit:${st.id}`, { action: "Review in stack-viewer, then submit", detail: "", stack: st.id });
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
    if (last && !last.end) return false;
    // You asked: whether you're present or not.
    if (this.s.pollRequested && (!last || Date.parse(this.s.pollRequested) > last.startedAt)) return true;
    if (!last) return true;
    // Every few minutes while you're at the page, every few hours while you're away; every 2 minutes for 10 after you
    // copied a moz-phab command (you're resubmitting).
    const age = this.ctx.now - last.startedAt;
    if (Object.values(this.s.stacks).some((st) => st.submitCopied && this.ctx.now - Date.parse(st.submitCopied) < 10 * 60_000)) return age >= SUBMIT_IMPORT_MS;
    if (this.ctx.presence.present) return age >= (this.config.phabPollMinutes ?? 10) * 60_000;
    return age >= (this.config.phabPollHours ?? 3) * HOUR;
  }

  // Revisions are checked whatever the step (a stack back on try for review fixes is still on Phabricator), and for three
  // days after the request is done (a backout reopens them).
  private pollPhab(): void {
    const revisions = Object.values(this.s.patches).filter((p) => p.revision !== undefined);
    if (this.s.step === "done" && (!this.s.finishedAt || this.ctx.now - Date.parse(this.s.finishedAt) > 3 * 24 * HOUR)) return;
    if (revisions.length === 0 || !this.pollDue()) return;
    const n = this.view.jobs.filter((j) => j.purpose.what === "poll").length;
    const ds = revisions.map((p) => p.revision!).sort((a, b) => a - b);
    this.want(`poll:${n}`, () => this.cli("poll", "phab.ts", ["poll", ...ds.map((d) => `D${d}`)], { priority: REVIEW_PRIORITY }));
  }

  // The commit Phabricator's latest diff came from, when this repository has it: one you submitted from elsewhere (your
  // own checkout, after a reorg) isn't, and what the factory last sent stands for it.
  private phabBase(p: PatchView): string | undefined {
    const commit = p.review?.diff?.commit;
    if (commit === undefined) return undefined;
    return this.knownCommit(p, commit) ? commit : p.sentSha;
  }

  // One of its own commits, now or before: this repository has it.
  private knownCommit(p: PatchView, sha: string): boolean {
    return sha === p.sha || sha === p.sentSha || (p.pastShas ?? []).includes(sha);
  }

  private reviewComments(): void {
    const revisions = Object.values(this.s.patches).filter((p) => p.revision !== undefined);
    this.pollPhab();
    if (this.s.step !== "review comments" && this.s.step !== "landing") return;
    const lastPoll = this.view.jobs.filter((j) => j.purpose.what === "poll" && succeeded(j)).at(-1);
    for (const n of this.s.needsUser.filter((x) => x.key.startsWith("resubmit:"))) {
      // Done once Phabricator has a diff newer than the request (polls from before diffs were read: the next poll).
      const diff = n.patch === undefined ? undefined : this.s.patches[n.patch]?.review?.diff;
      const raised = this.view.raised.get(n.key) ?? Infinity;
      if (diff ? Date.parse(diff.created) > raised : lastPoll && lastPoll.startedAt > raised) this.clear(n.key);
    }
    // Landed: nothing left to resubmit or reply to.
    for (const n of this.s.needsUser) {
      if (n.patch !== undefined && /^(resubmit|reply):/.test(n.key) && this.s.patches[n.patch]?.review?.status === "published") this.clear(n.key);
    }
    // A patch whose code differs from what Phabricator has needs resubmitting, whatever happened to its flags: a
    // waiting patch gets one once that interdiff shows a change.
    for (const p of revisions) {
      const st = Object.values(this.s.stacks).find((x) => x.order.includes(p.id));
      const base = this.phabBase(p);
      const item = p.item ? this.s.items[p.item] : undefined;
      if (!st || !base || base === p.sha || item?.state !== "waiting for review" || p.review?.status === "published") continue;
      if (this.s.needsUser.some((n) => n.patch === p.id && (n.key.startsWith("resubmit:") || n.key.startsWith("reply:")))) continue;
      const inter = this.want(`interdiff:${p.id}:phab-${base.slice(0, 12)}:${p.sha.slice(0, 12)}`, () =>
        this.cli("interdiff", "stack.ts", ["interdiff", "--cwd", st.worktree, base, p.sha], { cwd: st.worktree, priority: REVIEW_PRIORITY, purpose: { patch: p.id, stack: st.id } }),
      );
      if (inter && this.out<{ diff: string }>(inter).diff.trim()) {
        this.raise(`resubmit:${st.id}:phab-${p.review!.diff!.id}:${p.sha.slice(0, 12)}`, { action: `Resubmit D${p.revision}`, detail: "it differs from what Phabricator has · interdiff below", stack: st.id, patch: p.id });
      }
    }
    // What a resubmit would send: the patch as it is against what Phabricator has.
    for (const n of this.s.needsUser.filter((x) => x.key.startsWith("resubmit:") && x.patch !== undefined)) {
      const p = this.s.patches[n.patch!];
      const st = Object.values(this.s.stacks).find((x) => x.order.includes(p.id));
      const base = this.phabBase(p);
      if (!st || !base || base === p.sha) continue;
      const inter = this.want(`interdiff:${p.id}:phab-${base.slice(0, 12)}:${p.sha.slice(0, 12)}`, () =>
        this.cli("interdiff", "stack.ts", ["interdiff", "--cwd", st.worktree, base, p.sha], { cwd: st.worktree, priority: REVIEW_PRIORITY, purpose: { patch: p.id, stack: st.id } }),
      );
      // Phabricator has that code already: nothing to resubmit, only its replies to post (an answer that changed no code).
      if (inter && !this.out<{ diff: string }>(inter).diff.trim()) {
        if (n.action.startsWith("Post ")) this.raise(`reply:${n.key}`, { action: n.action.replace(", then resubmit", " on"), detail: "an answer that changes no code: the draft replies are on its row", stack: n.stack, patch: p.id });
        this.clear(n.key);
      }
    }
    for (const p of revisions) {
      if (!p.review || !p.item) continue;
      const item = p.item;
      const handled = new Set(this.view.jobs.filter((j) => j.purpose.patch === p.id && j.purpose.comments).flatMap((j) => j.purpose.comments!));
      const fresh = p.review.comments.filter((c) => !c.done && isReviewComment(p, c) && !handled.has(c.id));
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
    // Review rounds and the nits pass after the answer resume its session under the first prompt's name. Since it was
    // submitted, any change its author made goes to Phabricator: an answer to review comments, or what you told it,
    // or what it made of a try push it asked for.
    const answer = this.authorJobs(item.id).findLast((j) => j.purpose.reason !== undefined && CHANGES_AFTER_SUBMIT.includes(j.purpose.reason) || j.purpose.reason === "initial" || j.purpose.reason === "start" || j.name === "address-review");
    if (!author || !answer || answer.purpose.reason === "initial" || answer.purpose.reason === "start" || item.state !== "reviewed") return;
    if (answer.name !== "address-review" && !(p.submittedAt && answer.startedAt > Date.parse(p.submittedAt))) return;
    const st = Object.values(this.s.stacks).find((x) => x.order.includes(p.id));
    if (!st) return;
    const previous = this.authorJobs(item.id).filter((j) => succeeded(j) && j.startedAt < answer.startedAt && commitsOf(j.name, this.rep(j)).length > 0).at(-1);
    const index = author.commits.findIndex((_, i) => patchId(item.id, i) === p.id);
    // Against what Phabricator had when it was answered (what the reviewer saw), not the author's previous commit (which
    // may never have been sent), nor a moz-phab command copied since.
    const sentBefore = (this.s.patchSent[p.id] ?? []).filter((x) => Date.parse(x.t) < answer.startedAt && this.knownCommit(p, x.sha)).at(-1)?.sha;
    const oldSha = sentBefore ?? p.sentSha ?? (previous ? commitsOf(previous.name, this.rep(previous))[index] : undefined);
    // Rebuilt on today's central (patches that landed drop out), with each submitted patch's Differential Revision
    // line. v2: a conflict is left for resolve-conflict, as in the stack's assembly.
    const key = `rewrite-review:${st.id}:${author.job.job}:v2`;
    const rewrite = (k: string) => {
      const e = this.rewriteEdits(k.replace(/[:]/g, "-"), st.order.map((pid) => this.s.patches[pid]));
      return this.want(k, () =>
        this.cli("rewrite", "stack.ts", ["rewrite", "--cwd", st.worktree, "--base", st.base ?? this.config.baseRef, "--branch", st.branch, "--order", st.order.map((pid) => this.s.patches[pid].sha).join(","), "--leave-conflict", ...e.args], {
          cwd: st.worktree,
          files: e.files,
          priority: REVIEW_PRIORITY,
          purpose: { stack: st.id, patches: Object.fromEntries(st.order.map((pid) => [this.s.patches[pid].sha.slice(0, 12), pid])) },
        }),
      );
    };
    const rw = rewrite(key);
    if (!rw) return;
    const conflict = this.out<{ conflict?: { sha: string; files: string[] } }>(rw).conflict;
    if (conflict) {
      const res = this.wantAgent(`resolve:${st.id}:review-${author.job.job}:${conflict.sha}`, "resolve", "resolve-conflict", { sha: conflict.sha, base: st.branch, files: conflict.files.join(", ") }, {
        cwd: st.worktree,
        priority: REVIEW_PRIORITY,
        purpose: { stack: st.id, sha: conflict.sha, patches: Object.fromEntries(st.order.filter((pid) => this.s.patches[pid].sha.startsWith(conflict.sha.slice(0, 12))).map((pid) => [conflict.sha.slice(0, 12), pid])) },
      });
      if (!res) return;
      const r = this.rep<ResolveConflictReport>(res);
      if (r.state !== "resolved" || !r.commit) {
        this.raise(`failed:${res.job}`, { action: "Its amended commit doesn't apply on today's central", detail: r.explanation.slice(0, 500), job: res.job, item: item.id });
        return;
      }
      // Once more, for the Differential Revision line the resolution's commit lacks.
      if (!rewrite(`${key}:resolved`)) return;
    }
    if (p.worktree !== st.worktree) return;
    if (oldSha) {
      const inter = this.want(`interdiff:${p.id}:${author.job.job}:${oldSha.slice(0, 12)}`, () =>
        this.cli("interdiff", "stack.ts", ["interdiff", "--cwd", st.worktree, oldSha, p.sha], { cwd: st.worktree, priority: REVIEW_PRIORITY, purpose: { patch: p.id, stack: st.id } }),
      );
      if (!inter) return;
    }
    const replies = (this.rep<AddressReviewReport>(answer).replies ?? []).length;
    // The latest answer's flag stands for the patch: earlier ones are moot.
    for (const n of this.s.needsUser) if (n.patch === p.id && n.key.startsWith("resubmit:") && n.key !== `resubmit:${st.id}:${author.job.job}`) this.clear(n.key);
    this.raise(`resubmit:${st.id}:${author.job.job}`, {
      action: `${replies ? `Post ${replies} ${replies === 1 ? "reply" : "replies"}, then resubmit` : "Resubmit"} D${p.revision}`,
      detail: `${answer.name === "address-review" ? "comments addressed" : "changed by its author since you submitted it"} and re-reviewed (Opus) · interdiff below`,
      stack: st.id,
      patch: p.id,
    });
    this.setItem(item.id, "waiting for review");
  }

  // After submission, fixes made since (tests you asked to fix, failures a push found) go on top of the stack once
  // reviewed, for you to submit; the step stays. Once on Phabricator, they wait for review like the others.
  private newPatches(): void {
    if (this.s.step !== "review comments" && this.s.step !== "landing") return;
    const stacked = new Set(Object.values(this.s.stacks).flatMap((st) => st.order));
    const own = (i: ItemView) => (this.authorReport(i.id)?.commits ?? []).map((_, n) => this.s.patches[patchId(i.id, n)]).filter((p) => p !== undefined);
    for (const st of this.liveStacks()) {
      const items = Object.values(this.s.items).filter((i) => this.stackFolder(i) === st.folder);
      for (const i of items) if (i.state === "in stack" && own(i).length && own(i).every((p) => p.revision !== undefined && st.order.includes(p.id))) this.setItem(i.id, "waiting for review");
      if (st.order.every((pid) => this.s.patches[pid].revision !== undefined)) for (const n of this.s.needsUser) if (n.key.startsWith(`submit-new:${st.id}:`)) this.clear(n.key);
      const fresh = items.filter((i) => i.state === "reviewed").flatMap(own).filter((p) => !stacked.has(p.id) && p.revision === undefined);
      if (!fresh.length) continue;
      const all = [...st.order.map((pid) => this.s.patches[pid]), ...fresh];
      // By their authors' runs, not their shas, which the rewrite changes.
      const h = shortHash(fresh.map((p) => `${p.id}:${p.item ? this.latestAuthor(p.item)?.job : ""}`)).slice(0, 10);
      const e = this.rewriteEdits(`append-${st.id}-${h}`, all);
      const rw = this.want(`append:${st.id}:${h}`, () =>
        this.cli("rewrite", "stack.ts", ["rewrite", "--cwd", st.worktree, "--base", st.base ?? this.config.baseRef, "--branch", st.branch, "--order", all.map((p) => p.sha).join(","), ...e.args], {
          cwd: st.worktree,
          files: e.files,
          purpose: { stack: st.id, reason: "new patches on top", patches: Object.fromEntries(all.map((p) => [p.sha.slice(0, 12), p.id])) },
        }),
      );
      if (!rw) continue;
      if (this.out<{ conflict?: unknown }>(rw).conflict) {
        this.raise(`failed:${rw.job}`, { action: "Conflict while adding new patches on top of the stack", detail: "stack.ts rewrite stopped on a conflict", job: rw.job, stack: st.id });
        continue;
      }
      const { id, ...rest } = st;
      this.event(this.ev("stack", { stack: id, ...rest, order: all.map((p) => p.id) }));
      for (const i of new Set(fresh.map((p) => p.item!))) this.setItem(i, "in stack");
      const unfiled = fresh.some((p) => p.bug === null && p.bugDraft);
      this.raise(`submit-new:${st.id}:${h}`, {
        action: `Submit ${fresh.length} new ${fresh.length === 1 ? "patch" : "patches"}`,
        detail: `${fresh.map((p) => p.title.replace(/,\s*r=.*$/, "")).join("; ")}: on top of the stack, reviewed. ${unfiled ? "File its bug (the draft on its row), then copy" : "Copy"} the moz-phab submit command.`.slice(0, 500),
        stack: st.id,
      });
    }
  }

  // A backout reopens its revision on Phabricator: then, once the sheriff said why on its bug, the patches it took that
  // the failure names (by their files or tests; all of them when it names none of theirs) are its cause. Each cause's
  // author is told; it lands again only once a try push shows the failing jobs green with its fix. The others may land
  // again right away.
  private backouts(): void {
    for (const [pid, at] of Object.entries(this.s.reopened)) {
      const p = this.s.patches[pid];
      if (!p || p.bug === null || this.s.backouts[pid]?.at === at) continue;
      if (this.s.step === "done") this.setStep("landing");
      // The sheriff's comment may come a few minutes after the backout: asked again every few minutes until it's there.
      const asked = this.view.jobs.filter((j) => j.purpose.key.startsWith(`backout-reason:${pid}:${at}:`));
      const last = asked.at(-1);
      const said = last && succeeded(last) ? this.out<BugLandings[]>(last)[0]?.backout : undefined;
      if (!said || Date.parse(said.t) < Date.parse(at) - HOUR) {
        if (!last || (last.end && this.ctx.now - last.startedAt >= 5 * 60_000)) {
          this.want(`backout-reason:${pid}:${at}:${asked.length}`, () => this.cli("backout-reason", "bugzilla.ts", ["landings", String(p.bug)], { priority: REVIEW_PRIORITY }));
        }
        continue;
      }
      // What the same backout took: the revisions reopened with it.
      const taken = Object.entries(this.s.reopened)
        .filter(([, t]) => Math.abs(Date.parse(t) - Date.parse(at)) < HOUR)
        .map(([id]) => this.s.patches[id])
        .filter((x) => x !== undefined);
      const names = [...said.text.matchAll(/@\s*([\w./-]+\.(?:html|xhtml|xht|js|toml|ini))/g)].map((m) => m[1].split("/").pop()!);
      const named = (x: PatchView) => [...this.patchFiles(x), ...(x.item ? (this.s.items[x.item]?.group.tests ?? []) : [])].some((f) => names.some((n) => f === n || f.endsWith(`/${n}`)));
      const causes = taken.filter(named);
      this.event(this.ev("backout", { patch: pid, at, reason: said.text, culprit: causes.length ? causes.includes(p) : true }));
    }
    for (const [pid, b] of Object.entries(this.s.backouts)) {
      const p = this.s.patches[pid];
      if (!b.culprit || b.verified || !p?.item) continue;
      const item = p.item;
      const key = `author:${item}${this.itemEpoch(item)}:backout:${pid}:${b.at}`;
      const run = this.resumeAuthor(
        item,
        key,
        "backout",
        `D${p.revision} landed, then was backed out:\n${b.reason}\n\nRead the failure (the log linked above, and the test's runs with fx-tests) and find whether your patch causes it. If it does, fix it by amending your commit. Either way, end with the JSON report again, saying what caused the failure. It won't land again before a try push shows those jobs green with your fix.`,
      );
      // Its answer reviewed and back on its way to Phabricator: then the push.
      if (!run || this.s.items[item].state !== "waiting for review") continue;
      const st = Object.values(this.s.stacks).find((x) => x.order.includes(pid));
      if (!st) continue;
      const text = `Verify D${p.revision} (${p.title}) after its backout, with its fix: the jobs that failed must be green. The backout: ${b.reason.slice(0, 1500)}`;
      const n = (this.s.verifyAsked ?? []).indexOf(text) + 1;
      if (!n) {
        this.event(this.ev("verify-asked", { text }));
        continue;
      }
      const pushes = Object.values(this.s.pushes).filter((x) => x.id.startsWith(`${st.id}-ask${n}-`) && x.rev);
      if (pushes.length && pushes.every((x) => x.result === "green" || this.passing.has(x.id))) this.event(this.ev("backout-verified", { patch: pid }));
    }
  }

  // -------------------------------------------------------------------------
  // 10. Landing

  private landing(): void {
    if (this.s.step !== "review comments" && this.s.step !== "landing") return;
    const patches = Object.values(this.s.patches).filter((p) => p.revision !== undefined);
    const landed = (p: PatchView) => landingState(this.s, p).landed;
    const accepted = (p: PatchView) => landingState(this.s, p).accepted;
    for (const item of Object.values(this.s.items)) {
      const own = patches.filter((p) => p.item === item.id);
      if (own.length > 0 && own.every(landed) && item.state !== "landed") this.setItem(item.id, "landed");
      // Backed out: it waits again.
      else if (item.state === "landed" && !own.every(landed)) this.setItem(item.id, "waiting for review");
    }
    if (patches.length > 0 && patches.every(landed)) {
      this.setStep("done");
      return;
    }
    if (patches.some(accepted)) this.setStep("landing");
    if (this.s.step !== "landing") return;
    for (const st of this.liveStacks()) {
      const ps = st.order.map((pid) => this.s.patches[pid]);
      // What makes patches landable, not their order or shas: the reorder below changes those.
      const h = shortHash(ps.map((p) => `${p.id}:${JSON.stringify(landingState(this.s, p))}`).sort()) + this.stepEpoch("landing");
      const file = dataPath(this.config, this.s.id, `landable-${st.id}-${h}.json`);
      const ord = this.want(`order-landable:${st.id}:${h}`, () =>
        this.cli("order", "stack.ts", ["order", file], {
          purpose: { stack: st.id },
          files: [
            {
              path: file,
              content:
                JSON.stringify({
                  patches: ps.map((p) => ({ id: p.id, effort: p.effort, value: this.s.items[p.item ?? ""]?.group.ratePerWeek, testOnly: p.testOnly, ...landingState(this.s, p) })),
                  deps: ps.flatMap((p) => p.deps),
                  previous: st.order,
                }) + "\n",
            },
          ],
        }),
      );
      if (!ord) continue;
      const o = this.out<OrderOutput>(ord);
      // One reorg to ask for at a time, for the stack's order: an earlier one's is moot.
      const landKey = `land:${st.id}:${shortHash(st.order).slice(0, 10)}`;
      for (const n of this.s.needsUser) if (n.key.startsWith(`land:${st.id}:`) && n.key !== landKey) this.clear(n.key);
      if (!o.landable.length) continue;
      // v2: earlier versions gave landed patches an edit, which the rewrite refused.
      if (o.order.join() !== st.order.join() || this.view.byKey.has(`rewrite-land:${st.id}:${h}:v2`)) {
        // Landed patches leave the order, and their edits with them.
        const e = this.rewriteEdits(`land-${st.id}-${h}`, o.order.map((pid) => this.s.patches[pid]));
        const rw = this.want(`rewrite-land:${st.id}:${h}:v2`, () =>
          this.cli("rewrite", "stack.ts", ["rewrite", "--cwd", st.worktree, "--base", st.base ?? this.config.baseRef, "--branch", st.branch, "--order", o.order.map((pid) => this.s.patches[pid].sha).join(","), ...e.args], {
            cwd: st.worktree,
            files: e.files,
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
      // Whenever the stack's order differs from Phabricator's, whichever reorder made it: landable patches already at the
      // bottom there need nothing.
      const phab = st.submittedOrder?.filter((pid) => st.order.includes(pid));
      if (!phab || phab.join() === st.order.join()) {
        this.clear(landKey);
        continue;
      }
      const n = o.landable.length;
      const k = o.flippedSoftDeps.length;
      const adapted = k ? ` (${k} soft ${k === 1 ? "dependency" : "dependencies"} adapted)` : "";
      this.raise(landKey, { action: `Stack reordered: ${n} landable ${n === 1 ? "patch" : "patches"} moved to the bottom`, detail: `Run moz-phab reorg so Phabricator has the new order${adapted}.`, stack: st.id });
    }
  }

  // A submitted patch's commit in its author's worktree has no Differential Revision line: every rewrite of a stack
  // gives it back, or the next moz-phab submit would make a new revision. Edits keyed by sha, merged with others.
  private rewriteEdits(name: string, patches: PatchView[], edits: Record<string, MessageEdit> = {}): { args: string[]; files: { path: string; content: string }[] } {
    const all: Record<string, MessageEdit> = { ...edits };
    for (const p of patches) if (p.revision !== undefined) all[p.sha] = { ...all[p.sha], revision: `https://phabricator.services.mozilla.com/D${p.revision}` };
    if (Object.keys(all).length === 0) return { args: [], files: [] };
    const file = dataPath(this.config, this.s.id, `edits-${name}.json`);
    return { args: ["--edits", file], files: [{ path: file, content: JSON.stringify(all) + "\n" }] };
  }

  // Each worktree is ~6 GB: those of groups closed without a fix, and the signal worktrees a redo replaced, go
  // right away, once nothing runs in them.
  private pruneWorktrees(): void {
    for (const j of this.view.jobs.filter((j) => j.purpose.what === "worktree" && succeeded(j))) {
      const { name, path } = this.out<{ name: string; path: string }>(j);
      const item = j.purpose.item === undefined ? undefined : this.s.items[j.purpose.item];
      const closed = item !== undefined && (item.state === "left as-is" || item.state === "handed back");
      const replaced = j.purpose.key.startsWith("wt:signal") && j.purpose.key !== `wt:signal${this.annotationsEpoch()}`;
      if (!closed && !replaced) continue;
      if (this.view.jobs.some((r) => r.end === undefined && (r.cwd === path || r.cwd?.startsWith(`${path}/`)))) continue;
      this.want(`remove:${name}`, () => this.cli("remove", "worktree.ts", ["remove", name], { cwd: this.config.firefoxRepo, ...(item ? { item: item.id, purpose: { item: item.id } } : {}) }));
    }
  }

  // Once a request is done, its worktrees go, except those of groups you took over: yours now. The cwd is the main
  // checkout: worktree.ts remove kills every process under the worktree, which would include a job running inside it.
  private cleanup(): void {
    const names = new Set(
      this.view.jobs
        // A split request's groups went to the new requests, with their worktrees.
        .filter((j) => j.purpose.what === "worktree" && succeeded(j) && !(j.purpose.item !== undefined && (this.s.splitInto || this.s.items[j.purpose.item]?.state === "taken over")))
        .map((j) => this.out<{ name: string }>(j).name),
    );
    // The stack's stays while its landings are watched (a backout comes back to it).
    const watched = this.s.finishedAt !== undefined && this.ctx.now - Date.parse(this.s.finishedAt) <= 3 * 24 * HOUR;
    const stacks = new Set(Object.values(this.s.stacks).map((st) => basename(st.worktree)));
    for (const name of names) {
      if (watched && stacks.has(name)) continue;
      this.want(`remove:${name}`, () => this.cli("remove", "worktree.ts", ["remove", name], { cwd: this.config.firefoxRepo }));
    }
  }
}
