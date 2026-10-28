// What a finished job's output means, as events. Pure: the runner reads the output, validates
// agent reports, and appends what these functions return. Only successful jobs get here; failures
// are next()'s business (retry, then failed:<job>).
import { relative } from "node:path";
import type { ClusterGroup } from "../cli/failures.ts";
import type { PollResult } from "../cli/phab.ts";
import type { ImportedCommit } from "../cli/stack/import.ts";
import type { SinceResult } from "../cli/stack/since.ts";
import type { DryRunResult, WatchLine } from "../cli/try.ts";
import type { CommandInput } from "../state/commands.ts";
import type { EventInput } from "../state/events.ts";
import { sameBugDraft } from "../state/meta-bug.ts";
import type {
  AddressReviewReport,
  Dep,
  FactoryConfig,
  InlineComment,
  InvestigateReport,
  JobId,
  PatchView,
  PushId,
  RecoverReport,
  RequestState,
  ReviewPatchReport,
  WriteHandOffReport,
  WriteTestPlanReport,
} from "../types.ts";
import { patchId } from "./next.ts";
import { dataPath } from "./plan.ts";
import type {
  BugDraft,
  ClassifyReviewCommentsReport,
  EstimateReviewEffortReport,
  MergeClustersReport,
  RouteRequestReport,
  ResolveConflictReport,
  ReviewStackReport,
  ReviseBugDraftReport,
  WriteMetaBugReport,
  TriageTryReport,
  WriteAnnotationPatchesReport,
} from "../types.ts";
import { succeeded, type JobRecord, type View } from "./view.ts";

export interface HandlerInput {
  state: RequestState;
  view: View;
  config: FactoryConfig;
  job: JobRecord;
  output: string; // out.log
  report?: unknown; // validated, for agents
  reportOf: (job: JobId) => unknown; // reports of earlier agent jobs
  outputOf: (job: JobId) => string; // out.log of earlier jobs
  commitExists?: (cwd: string, sha: string) => boolean; // an author's reported commits are checked against its worktree
}

// A report that matches its schema but not what the agent was asked: the runner records it as an
// invalid report, so the agent gets one retry with the error.
export class InvalidReport extends Error {}

export interface HandlerResult {
  events: EventInput[];
  files?: { path: string; content: string }[];
  commands?: CommandInput[]; // appended to commands.jsonl, after the events
}

type Fields<T extends EventInput["type"]> = Omit<Extract<EventInput, { type: T }>, "type" | "request" | "v" | "t">;

export function handleFinished(input: HandlerInput): HandlerResult {
  const { state: s, job, config } = input;
  const purpose = job.purpose;
  const events: EventInput[] = [];
  const files: { path: string; content: string }[] = [];
  const commands: CommandInput[] = [];
  const ev = <T extends EventInput["type"]>(type: T, fields: Fields<T>) => events.push({ type, request: s.id, ...fields } as unknown as EventInput);
  const json = <T>() => JSON.parse(input.output) as T;
  const patchEvent = (p: PatchView, changes: Partial<PatchView>) => {
    const { deps: _d, review: _r, replyDrafts: _rd, id, ...rest } = { ...p, ...changes };
    ev("patch", { patch: id, ...rest });
  };
  // Keyed by the sha an author reported, which may be shorter than 12 characters; the scripts answer with full ones.
  const byShaPrefix = (sha: string): PatchView | undefined => {
    const key = Object.keys(purpose.patches ?? {}).find((k) => sha.startsWith(k) || k.startsWith(sha.slice(0, 12)));
    return key === undefined ? undefined : s.patches[purpose.patches![key]];
  };

  switch (purpose.what) {
    case "route": {
      // A wrong answer throws: the agent is resumed with the error once, then it comes to you.
      const r = input.report as RouteRequestReport;
      if (r.existing !== undefined) {
        if (!purpose.requests?.includes(r.existing)) throw new Error(`${r.existing} is not one of the active requests`);
        commands.push({ id: `forward-${job.job}`, cmd: "tell-factory", request: r.existing, text: s.text });
        ev("request-forwarded", { to: r.existing });
        ev("step", { step: "done" });
        break;
      }
      if (r.kind === undefined) throw new Error("the report has neither existing nor kind");
      // The folder ends up in CLI arguments and worktree paths, the revision in a Treeherder URL.
      if (r.kind === "burndown" && !(r.folder && !r.folder.startsWith("/") && !r.folder.split("/").includes(".."))) throw new Error(`a burndown needs a folder relative to the repository, not ${JSON.stringify(r.folder)}`);
      if (r.kind === "try-push" && !/^[0-9a-f]{12,40}$/i.test(r.rev ?? "")) throw new Error(`a try-push request needs a revision of 12 to 40 hex digits, not ${JSON.stringify(r.rev)}`);
      ev("request-routed", { kind: r.kind, ...(r.kind === "burndown" ? { folder: r.folder } : { rev: r.rev }) });
      const questions = r.questions ?? [];
      ev("config-set", { config: { ...r.config, ...(questions.length ? { questions } : {}) } });
      break;
    }
    case "merge": {
      // Merging and splitting moves tests between groups, never adds or drops one: a dropped test
      // would never get an item.
      const cluster = input.view.byKey.get(purpose.key.replace(/^merge:/, "cluster:"))!.findLast(succeeded)!;
      const clusters = (JSON.parse(input.outputOf(cluster.job)) as { groups: ClusterGroup[] }).groups;
      const given = new Set(clusters.flatMap((g) => g.tests));
      const keys = new Set(clusters.map((g) => g.key));
      const report = input.report as MergeClustersReport;
      const got = new Set(report.groups.flatMap((g) => g.tests));
      const missing = [...given].filter((t) => !got.has(t));
      const extra = [...got].filter((t) => !given.has(t));
      // Where each group failed comes from the clusters it names: an unknown key would lose it.
      const unknown = [...new Set(report.groups.flatMap((g) => g.from).filter((k) => !keys.has(k)))];
      if (missing.length || extra.length || unknown.length) {
        const problems = [
          missing.length ? `tests missing from your groups: ${missing.join(", ")}` : "",
          extra.length ? `tests that weren't in the input groups: ${extra.join(", ")}` : "",
          unknown.length ? `\`from\` names clusters that don't exist: ${unknown.join(", ")} (use the input groups' \`key\` values)` : "",
        ];
        throw new InvalidReport(`${problems.filter(Boolean).join("; ")}. Every test of the input groups must be in your groups, and only those.`);
      }
      break;
    }
    case "author":
      authorReport(input, ev);
      break;
    case "import": {
      // The author's commits, oldest first, become the item's patches.
      const commits = json<ImportedCommit[]>();
      const author = input.view.jobs.find((j) => `import:${j.job}` === purpose.key);
      const report = author ? (input.reportOf(author.job) as Partial<InvestigateReport>) : {};
      // Each bug draft goes to the commits it's for; an older report's single draft to its first commit without a bug.
      const draftIndex = commits.findIndex((c) => c.bug === null);
      const draftOf = (c: ImportedCommit, i: number) =>
        report.bugDrafts?.find((d) => d.commits.some((x) => c.sha.startsWith(x) || x.startsWith(c.sha.slice(0, 12))))?.draft ?? (!report.bugDrafts && i === draftIndex ? report.bugDraft : undefined);
      commits.forEach((c, i) => {
        const id = patchId(purpose.item!, i);
        const existing = s.patches[id];
        ev("patch", {
          patch: id,
          item: purpose.item,
          sha: c.sha,
          worktree: job.cwd,
          title: c.title,
          // Only the bug you gave outlives a commit that says Bug XXXXXXX: an earlier commit's own number (the same
          // patch id reused for another commit) doesn't.
          bug: c.bug ?? (existing?.bugFromYou ? existing.bug : null),
          ...(c.bug === null && existing?.bugFromYou ? { bugFromYou: true } : {}),
          ...(c.bug === null && draftOf(c, i) ? { bugDraft: draftOf(c, i) } : existing?.bugDraft ? { bugDraft: existing.bugDraft } : {}),
          ...(c.revision ?? existing?.revision ? { revision: c.revision ?? existing?.revision } : {}),
          ...(existing?.effort ? { effort: existing.effort } : {}),
          testOnly: c.testOnly,
        });
      });
      break;
    }
    case "dry-run": {
      const d = json<DryRunResult>();
      if (d.duplicateOf !== undefined) {
        ev("note", { text: `Push ${purpose.push} is the same as pending push ${d.duplicateOf}: not planned again.` });
        break;
      }
      ev("try-planned", { push: purpose.push!, purpose: purpose.purpose ?? "", command: d.command, taskCount: d.taskCount });
      ev("needs-user", {
        key: `approve-push:${purpose.push}`,
        action: `Approve try push ${purpose.push}`,
        detail: [`${d.taskCount} tasks`, purpose.purpose, ...d.warnings].filter(Boolean).join(" · ").slice(0, 1000),
        push: purpose.push,
      });
      break;
    }
    case "push": {
      const o = json<{ rev?: string; treeherderUrl?: string; dryRun?: boolean; command?: string[] }>();
      if (o.dryRun) ev("note", { text: `Dry run: try push ${purpose.push} not made.` });
      else if (o.rev) ev("try-pushed", { push: purpose.push!, rev: o.rev, url: o.treeherderUrl ?? `https://treeherder.mozilla.org/jobs?repo=try&revision=${o.rev}` });
      break;
    }
    case "triage": {
      const r = input.report as TriageTryReport;
      const noted = r.cells.filter((c) => c.verdict === "pre-existing" || c.verdict === "infra");
      for (const verdict of ["pre-existing", "infra"] as const) {
        const cells = noted.filter((c) => c.verdict === verdict);
        if (cells.length === 0) continue;
        const what = verdict === "infra" ? "Infra failures (a retrigger is a push: ask for it)" : "Also failing on central";
        ev("note", { text: `${what} on push ${purpose.push}: ${cells.map((c) => `${c.test ?? c.taskId ?? "?"}${c.config ? ` (${c.config})` : ""}`).join(", ")}`.slice(0, 2000) });
      }
      break;
    }
    case "assemble":
    case "rewrite": {
      const o = json<{ commits?: { sha: string; newSha: string }[]; mapping?: Record<string, string> }>();
      const pairs = [...(o.commits ?? []).map((c) => [c.sha, c.newSha] as const), ...Object.entries(o.mapping ?? {})];
      for (const [old, sha] of pairs) {
        const p = byShaPrefix(old);
        if (!p) continue;
        const changes: Partial<PatchView> = { sha, worktree: job.cwd };
        const bug = purpose.edits?.[p.id];
        if (bug !== undefined) {
          changes.bug = bug;
          changes.title = p.title.replace(/^Bug X+\b/i, `Bug ${bug}`);
        }
        if (purpose.titles?.[p.id]) changes.title = purpose.titles[p.id];
        patchEvent(p, changes);
      }
      break;
    }
    case "resolve": {
      const r = input.report as ResolveConflictReport;
      const p = byShaPrefix(purpose.sha!);
      if (r.state === "resolved" && r.commit && p) patchEvent(p, { sha: r.commit, worktree: job.cwd });
      break;
    }
    case "deps": {
      for (const d of json<Dep[]>()) {
        const patch = purpose.patches?.[d.patch.slice(0, 12)];
        if (!patch) continue;
        const needs = purpose.patches?.[d.needs.slice(0, 12)] ?? d.needs;
        ev("dep", { dep: { ...d, patch, needs } });
      }
      break;
    }
    case "effort": {
      const p = s.patches[purpose.patch!];
      if (p) patchEvent(p, { effort: (input.report as EstimateReviewEffortReport).effort });
      break;
    }
    case "review-stack": {
      const r = input.report as ReviewStackReport;
      const bySha = (sha: string) => Object.values(s.patches).find((p) => p.sha.startsWith(sha.slice(0, 12)));
      for (const d of r.addDeps) {
        const patch = bySha(d.patch);
        if (patch) ev("dep", { dep: { patch: patch.id, needs: bySha(d.needs)?.id ?? d.needs, kind: d.kind, reason: d.reason, source: "reviewer" } });
      }
      for (const d of r.removeDeps) {
        const patch = bySha(d.patch);
        if (patch) ev("dep-removed", { patch: patch.id, needs: bySha(d.needs)?.id ?? d.needs });
      }
      break;
    }
    case "summary": {
      const o = json<{ markdown: string; metaComment: string }>();
      const st = s.stacks[purpose.stack!];
      if (!st) break;
      const { id, ...rest } = st;
      ev("stack", { stack: id, ...rest, summary: o.metaComment });
      files.push({ path: dataPath(config, s.id, `summary-${id}.md`), content: o.markdown });
      for (const pid of st.order) {
        const item = s.patches[pid]?.item;
        if (item && s.items[item]?.state === "reviewed") ev("item-state", { item, state: "in stack" });
      }
      break;
    }
    case "import-submit":
    case "refresh": {
      // The stack's commits in branch order, which is the stack's order.
      const st = s.stacks[purpose.stack!];
      const commits = json<ImportedCommit[]>();
      // Matched by position: a branch that isn't the stack's patches would put one patch's commit on another.
      if (commits.length !== st.order.length) throw new Error(`the branch has ${commits.length} commits, the stack ${st.order.length} patches`);
      commits.forEach((c, i) => {
        const p = s.patches[st.order[i]];
        if (!p) return;
        if (p.sha === c.sha && p.title === c.title && p.revision === c.revision) return;
        patchEvent(p, { sha: c.sha, title: c.title, bug: c.bug ?? p.bug, ...(c.revision !== undefined ? { revision: c.revision } : {}) });
      });
      break;
    }
    case "poll": {
      const kinds = commentKinds(input);
      for (const r of json<PollResult[]>()) {
        const p = Object.values(s.patches).find((x) => x.revision === r.revision);
        if (!p) continue;
        ev("review-status", {
          patch: p.id,
          revision: r.revision,
          status: r.status,
          reviewers: r.reviewers,
          comments: r.comments.map((c) => toInline(c, kinds.get(c.id) ?? p.review?.comments.find((x) => x.id === c.id)?.kind)),
        });
      }
      break;
    }
    case "classify-comments": {
      const p = s.patches[purpose.patch!];
      if (!p?.review) break;
      const kinds = new Map((input.report as ClassifyReviewCommentsReport).comments.map((c) => [c.id, c.kind]));
      ev("review-status", { patch: p.id, ...p.review, comments: p.review.comments.map((c) => ({ ...c, ...(kinds.has(c.id) ? { kind: kinds.get(c.id) } : {}) })) });
      break;
    }
    case "interdiff": {
      const o = json<{ diff: string }>();
      const p = s.patches[purpose.patch!];
      const path = dataPath(config, s.id, `interdiff-${purpose.patch}-${job.job}.diff`);
      files.push({ path, content: o.diff });
      if (p) patchEvent(p, { interdiffFile: relative(config.stateDir, path) });
      break;
    }
    case "meta-draft": {
      // The meta bug's text, rewritten as the stack changes, until it's filed.
      const d = input.report as WriteMetaBugReport;
      const fields = { ...(d.product ? { product: d.product } : {}), ...(d.component ? { component: d.component } : {}), ...(d.blocks ? { blocks: [...new Set([...((purpose.draft as BugDraft).blocks ?? []), ...d.blocks])] } : {}) };
      if (!s.metaBug?.bug) ev("meta-bug", { bug: null, draft: { ...(purpose.draft as BugDraft), ...fields, description: d.description, ...(d.summary ? { summary: d.summary } : {}) } });
      break;
    }
    case "since": {
      // The interdiffs go to files: the page shows them, the try planner reads them.
      const o = json<SinceResult>();
      const changes = o.changes.map(({ interdiff, ...c }) => {
        if (!interdiff) return c;
        const path = dataPath(config, s.id, `interdiff-${c.patch}-since-${purpose.push}-${job.job}.diff`);
        files.push({ path, content: interdiff.diff });
        return { ...c, interdiffFile: relative(config.stateDir, path) };
      });
      ev("push-changes", { stack: purpose.stack!, since: purpose.push!, changes, removed: o.removed });
      break;
    }
    case "test-plan":
      if (s.patches[purpose.patch!]) ev("test-plan", { patch: purpose.patch!, text: (input.report as WriteTestPlanReport).testPlan.trim() });
      break;
    case "hand-off":
      ev("hand-off", { job: job.job, items: purpose.reason!.split(" "), text: (input.report as WriteHandOffReport).prompt.trim() });
      break;
    case "set-test-plan":
      ev("test-plan-sent", { patch: purpose.patch!, revision: Number(purpose.reason!.split("\n")[0]), text: purpose.reason!.split("\n").slice(1).join("\n") });
      break;
    case "revise-draft": {
      const draft = (input.report as ReviseBugDraftReport).draft;
      if (purpose.patch === "meta") ev("meta-bug", { bug: s.metaBug?.bug ?? null, draft });
      else if (s.patches[purpose.patch!]) for (const p of sameBugDraft(s, purpose.patch!)) patchEvent(p, { bugDraft: draft });
      break;
    }
    case "recover": {
      const r = input.report as RecoverReport;
      const text = (purpose.reason ?? "").slice(0, 500);
      ev("recovery-plan", { job: job.job, text, answer: r.answer, plan: r.plan, cannotDo: r.cannotDo, questions: r.questions });
      ev("needs-user", { key: `recovery:${job.job}`, action: "Its answer to you", detail: `You said: “${text}”`, job: job.job });
      if (purpose.replyTo && s.needsUser.some((n) => n.key === `recovery:${purpose.replyTo}`)) ev("user-done", { key: `recovery:${purpose.replyTo}` });
      break;
    }
    case "shell":
      ev("note", { text: `Shell in ${job.cwd} done: ${input.output.trim().split("\n").slice(-3).join(" / ").slice(0, 500)}` });
      break;
  }
  return { events, files, commands };
}

// The author runs that answer a message of yours.
const YOUR_MESSAGES = ["continue", "comment", "stack comments"];

function authorReport(input: HandlerInput, ev: <T extends EventInput["type"]>(type: T, fields: Fields<T>) => void): void {
  const { job } = input;
  const item = job.item!;
  const blocked = (summary: string, action = "The author is blocked") => {
    ev("item-state", { item, state: "blocked", detail: summary.slice(0, 300) });
    ev("needs-user", { key: `failed:${job.job}`, action, detail: summary.slice(0, 500), job: job.job, item });
  };
  switch (job.name) {
    case "investigate-and-fix": {
      const r = input.report as InvestigateReport;
      // An agent may write a sha from memory, its start right and the rest made up.
      const missing = input.commitExists ? r.commits.filter((c) => !input.commitExists!(job.cwd, c)) : [];
      if (missing.length) throw new InvalidReport(`${missing.join(", ")} ${missing.length === 1 ? "isn't a commit" : "aren't commits"} in ${job.cwd}: report each commit's sha exactly as \`git log --format=%H\` prints it.`);
      if (r.state === "blocked") {
        blocked(r.summary);
        return;
      }
      // Its DEBUG commits wait for the folder's try repro push: only once the failing jobs' profiles were read.
      if (r.state === "needs a try repro" && !r.profiles?.length) {
        throw new InvalidReport(
          "A DEBUG push is only for what the failing jobs' profiles can't show. Read the profiles of the failing tasks first (their profile_<test>.json.gz artifacts, with profiler-cli), list each with what it shows in `profiles`, and change or drop your DEBUG commits accordingly. If they have no profile, one entry saying so and how you checked.",
        );
      }
      if (r.state === "needs a try repro") {
        ev("item-state", { item, state: "waiting for a try repro", detail: r.summary.slice(0, 300) });
        return;
      }
      // A fix for a failure nobody saw happen can't be trusted.
      if (r.state === "not reproduced") {
        blocked(r.summary, "The author couldn't reproduce the failure");
        return;
      }
      if (r.state === "fix verified locally" && r.reproduction?.reproduced === false) {
        blocked(r.summary, "Fixed without reproducing the failure");
        return;
      }
      ev("item-state", { item, state: r.state, detail: r.summary.slice(0, 300) });
      // A refusal of what you told it waits for you.
      if (r.disagreement && YOUR_MESSAGES.includes(job.purpose?.reason ?? "")) {
        ev("needs-user", { key: `disagrees:${job.job}`, action: "Its author disagrees with you", detail: r.disagreement.slice(0, 1000), job: job.job, item });
      }
      if (r.state !== "fix verified locally") return;
      const patch = patchId(item, Math.max(0, r.commits.length - 1));
      for (const l of r.landsAfter) ev("dep", { dep: { patch, needs: l.what, kind: "hard", reason: l.reason, source: "agent" } });
      return;
    }
    case "write-annotation-patches": {
      const r = input.report as WriteAnnotationPatchesReport;
      ev("item-state", { item, state: r.runIf || r.removal ? "fix verified locally" : r.keepSkips?.length ? "blocked" : "left as-is", detail: r.summary.slice(0, 300) });
      return;
    }
    case "address-review": {
      const r = input.report as AddressReviewReport;
      if (r.state === "blocked") {
        blocked(r.summary);
        return;
      }
      const patch = job.purpose.patch!;
      for (const reply of r.replies) ev("reply-draft", { patch, commentId: reply.commentId, text: reply.text.slice(0, 2500) });
    }
  }
}

function commentKinds(input: HandlerInput): Map<number, InlineComment["kind"]> {
  const kinds = new Map<number, InlineComment["kind"]>();
  for (const j of input.view.jobs) {
    if (j.purpose.what !== "classify-comments" || !succeeded(j)) continue;
    for (const c of (input.reportOf(j.job) as ClassifyReviewCommentsReport).comments) kinds.set(c.id, c.kind);
  }
  return kinds;
}

function toInline(c: PollResult["comments"][number], kind: InlineComment["kind"]): InlineComment {
  return {
    id: c.id,
    author: c.author,
    ...(c.file ? { file: c.file } : {}),
    ...(c.line ? { line: c.line } : {}),
    text: c.text.slice(0, 1000),
    ...(c.suggestion ? { suggestion: c.suggestion.slice(0, 1000) } : {}),
    done: c.done,
    ...(kind ? { kind } : {}),
  };
}

// try.ts watch lines, read as they arrive. Idempotent: lines already reflected in the state
// produce nothing, so a restart can read the log from the start again.
export function handleWatchLines(s: RequestState, view: View, push: PushId, lines: unknown[]): EventInput[] {
  const events: EventInput[] = [];
  const ev = <T extends EventInput["type"]>(type: T, fields: Fields<T>) => events.push({ type, request: s.id, ...fields } as unknown as EventInput);
  const seen = new Set(view.tryFailures.filter((f) => f.push === push).map((f) => `${f.taskId}:${f.retryId}`));
  let pushed = s.pushes[push]?.rev !== undefined;
  let progress = s.pushes[push]?.progress;
  let finished = s.pushes[push]?.result !== undefined;
  for (const line of lines as WatchLine[]) {
    switch (line.type) {
      case "pushed":
        if (!pushed) ev("try-pushed", { push, rev: line.rev, url: line.url });
        pushed = true;
        break;
      case "job-failed": {
        const key = `${line.taskId}:${line.retryId}`;
        if (seen.has(key)) break;
        seen.add(key);
        ev("try-job-failed", { push, taskId: line.taskId, retryId: line.retryId, jobName: line.jobName, platform: line.platform, tier: line.tier, result: line.result });
        break;
      }
      case "progress":
        if (progress?.done === line.done && progress.total === line.total && progress.failures === line.failures && progress.tests?.done === line.tests?.done) break;
        progress = { done: line.done, total: line.total, failures: line.failures, ...(line.tests ? { tests: line.tests } : {}) };
        ev("try-progress", { push, ...progress });
        break;
      case "finished":
        if (!finished) ev("try-finished", { push, result: line.result, summary: line.summary.slice(0, 1000) });
        finished = true;
        break;
    }
  }
  return events;
}
