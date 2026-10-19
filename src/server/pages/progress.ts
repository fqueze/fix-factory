// What each group is doing, in plain words, and what a request (or the whole factory) is doing: working,
// waiting for you, or done. No internal state names.
import { canRetry, reviewLimitFlag } from "../../state/flags.ts";
import type { ItemState, ItemView, JobView, NeedsUser, RequestState, ReviewPatchReport } from "../../types.ts";
import { html, join, type Html } from "../html.ts";
import { continueBox, flagControls, flagItemOf, flagText, handBackButton, hasAuthorSession, isAuthorJob, retryButton } from "./actions.ts";
import { actionKind, elapsed, jobLabel, jobNoun, modelLabel, refusedOf, requestUrl, type RenderContext, type StateClass } from "./common.ts";

// What a running job does to its group. Author runs say why they were resumed (purpose.reason).
const AUTHOR_REASONS: Record<string, string> = {
  initial: "investigating",
  start: "investigating again",
  review: "author fixing critical review findings",
  nits: "author addressing review nits",
  lint: "author fixing lint problems",
  comment: "author answering your comment",
  "stack comments": "author answering your stack-viewer comments",
  continue: "author working on your message",
  recovery: "author following the recovery plan",
  try: "author fixing try failures",
};
const RUNNING: Record<string, string> = {
  "review-patch": "being reviewed",
  "address-review": "author addressing Phabricator review comments",
  "resolve-conflict": "resolving a conflict",
  "adapt-soft-dep": "adapting to a patch it depends on",
  "worktree.ts create": "building its worktree",
  "stack.ts import": "importing its commit",
  "git log": "reading its commit message",
  "lint-text.ts commit": "checking its commit message",
  "lint-text.ts bug": "checking its bug draft",
  "lint-text.ts reply": "checking its review replies",
};

export function runningSentence(job: JobView): string {
  if (job.name === "investigate-and-fix") {
    if (job.purpose?.retried) {
      return "author continuing where it stopped";
    }
    return AUTHOR_REASONS[job.purpose?.reason ?? "initial"] ?? "author working";
  }
  const what = RUNNING[job.name] ?? RUNNING[job.name.split(" ").slice(0, 2).join(" ")] ?? jobLabel(job.name);
  return job.name === "review-patch" && job.model ? `${what} by ${modelLabel(job.model)}` : what;
}

// A group where nothing runs and nothing waits for you. active: something should be running, so it has stalled.
export const IDLE: Record<ItemState, { text: (i: ItemView, builds: number) => string; active: boolean }> = {
  "not started": { text: () => "not started yet: waiting for an agent", active: false },
  "waiting for a build slot": { text: (_i, builds) => `waiting for a build slot (${builds} ${builds === 1 ? "build" : "builds"} running)`, active: false },
  investigating: { text: () => "investigating", active: true },
  "fix verified locally": { text: () => "fix verified locally, critical review next", active: true },
  "in critical review": { text: () => "being reviewed", active: true },
  "review findings": { text: () => "review findings go back to the author", active: true },
  reviewed: { text: () => "reviewed: waiting for the rest of the stack", active: false },
  "in stack": { text: () => "in the stack", active: false },
  "in try": { text: () => "being verified on try", active: false },
  "waiting for review": { text: () => "waiting for review on Phabricator", active: false },
  "addressing review comments": { text: () => "addressing Phabricator review comments", active: true },
  blocked: { text: () => "blocked", active: true },
  "waiting for a try repro": { text: () => "waiting for the try push of its DEBUG commit", active: false },
  fixed: { text: () => "done: fixed", active: false },
  landed: { text: () => "done: landed", active: false },
  "left as-is": { text: () => "closed", active: false },
  "handed back": { text: () => "closed: handed back to you", active: false },
};

const DONE: ItemState[] = ["fixed", "landed", "left as-is", "handed back"];

export interface ItemSentence {
  text: Html;
  cls: StateClass;
  controls: Html | null; // the ⚑'s buttons, or Continue/Retry for a stalled group
  detail?: string; // what adds to the sentence
  ask?: Html; // what you're asked to decide, and what you need to decide it
}

export function runningJobOf(r: RequestState, i: ItemView): JobView | undefined {
  return i.jobs.map((j) => r.jobs[j]).findLast((j) => j.endedAt === undefined);
}

export function itemSentence(r: RequestState, i: ItemView, ctx: RenderContext): ItemSentence {
  const job = runningJobOf(r, i);
  if (job) {
    return { text: html`${runningSentence(job)} · ${elapsed(job.startedAt, ctx)}`, cls: "run", controls: null, detail: i.detail };
  }
  const flag = r.needsUser.find((n) => flagItemOf(r, n) === i.id);
  if (flag) {
    return { text: html`needs you: ${flagText(r, flag)}`, cls: "find", controls: flagControls(r, flag, ctx), ask: flagAsk(r, i, flag) };
  }
  const idle = IDLE[i.state];
  if (idle.active) {
    // At the agent cap, next() is only waiting for a slot.
    if (ctx.maxAgents !== undefined && ctx.runningAgents !== undefined && ctx.runningAgents >= ctx.maxAgents) {
      return { text: html`waiting for an agent (${ctx.runningAgents}/${ctx.maxAgents} running)`, cls: "wait", controls: null, detail: i.detail };
    }
    const controls = stalledControls(r, i);
    return {
      text: html`${stalledText(r, i)}`,
      cls: "find",
      controls,
      detail: i.detail,
      ask: html`<p>The factory should be working on it, but nothing runs and nothing will on its own: a factory bug, or a job that was lost. ${
        hasAuthorSession(r, i.id) ? "Retry its last job, tell its author what to do, or hand it back to you." : "Retry its last job, or hand it back to you."
      }</p>`,
    };
  }
  const builds = ctx.runningBuilds ?? Object.values(r.jobs).filter((j) => j.kind === "build" && j.endedAt === undefined).length;
  // On try, its push is what runs.
  const cls = i.state === "in try" ? "run" : DONE.includes(i.state) ? (i.state === "fixed" || i.state === "landed" ? "ok" : "closed") : "wait";
  return { text: html`${idle.text(i, builds)}`, cls, controls: null, detail: i.detail };
}

// The question a group's ⚑ asks, with what you need to answer it; its buttons say what each answer does.
export function flagAsk(r: RequestState, i: ItemView, n: NeedsUser): Html {
  const job = n.job === undefined ? undefined : r.jobs[n.job];
  if (reviewLimitFlag(r, i.id) === n) {
    const report = i.lastReport?.prompt === "review-patch" ? (i.lastReport.report as ReviewPatchReport) : undefined;
    const findings = report?.findings.filter((f) => f.severity === "must-fix").map((f) => `${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : ""}${f.text}`) ?? n.detail.split("; ");
    return html`<p>Its critical reviews still find problems they say must be fixed. Read them and the patch, then accept the patch as it is, or tell its author what to change.</p><ul class="findings">${findings.map((f) => html`<li>${f}</li>`)}</ul>`;
  }
  switch (actionKind(n, r)) {
    case "stopped":
      return html`<p>You stopped ${job ? jobNoun(job.name) : "its job"}. Resume it, tell its author what to do instead, or dismiss this.</p>`;
    case "failed":
      if (job?.kind !== "agent") {
        return html`<p>${n.detail}</p><p>Retry it, tell its author what to do, or hand the group back to you.</p>`;
      }
      return isAuthorJob(job)
        ? html`<p>Its author stopped without a fix: ${n.detail}</p><p>Resume it where it stopped, tell it what to do, or hand the group back to you.</p>`
        : html`<p>${jobNoun(job.name).replace(/^./, (c) => c.toUpperCase())} failed: ${n.detail}</p><p>Retry it, or hand the group back to you.</p>`;
    case "disagrees":
      return html`<p>Its author didn't do what you asked: ${n.detail}</p><p>Tell it again, go ahead with its patch as it is, or hand the group back to you.</p>`;
    case "take-it":
      return html`<p>${n.detail}</p><p>Take it if it's yours to fix; hand it back to leave it to whoever is on it.</p>`;
    default:
      return html`<p>${n.detail}</p>`;
  }
}

// Nothing runs and nothing asks you: talk to its author, or run its last job again.
// Why it stalled, when its last job tells.
function stalledText(r: RequestState, i: ItemView): string {
  const last = i.jobs.map((j) => r.jobs[j]).at(-1);
  if (last?.error?.startsWith("cancelled by you")) {
    return `stalled after you stopped ${last.name === "investigate-and-fix" ? "its investigation" : `its ${jobLabel(last.name)}`}`;
  }
  if (last?.exitCode !== undefined && last.exitCode !== 0) {
    return `stalled after ${jobNoun(last.name)} failed`;
  }
  return "stalled: nothing running";
}

function stalledControls(r: RequestState, i: ItemView): Html {
  const back = requestUrl(r.id);
  const last = i.jobs.map((j) => r.jobs[j]).at(-1);
  const retry = last && last.exitCode !== 0 && canRetry(r, last) ? retryButton(r.id, last, back) : null;
  const talk = hasAuthorSession(r, i.id) ? continueBox(r.id, i.id, back) : null;
  return html`${retry}${talk}${handBackButton(r.id, i.id, back)}`;
}

// Where each group stands, counted per request (and for the whole factory) and drawn as a bar.
export type Bucket = "working" | "needs you" | "ready" | "pending" | "closed";
export const BUCKETS: Bucket[] = ["needs you", "working", "ready", "pending", "closed"];

const READY: ItemState[] = ["reviewed", "in stack", "waiting for review", "fixed", "landed"];

export function itemBucket(r: RequestState, i: ItemView, ctx: RenderContext): Bucket {
  const { cls } = itemSentence(r, i, ctx);
  if (cls === "run") {
    return "working";
  }
  if (cls === "find") {
    return "needs you";
  }
  if (cls === "closed") {
    return "closed";
  }
  return READY.includes(i.state) ? "ready" : "pending";
}

export type Progress = Record<Bucket, number>;

// Its groups; and the request's own ⚑s (recovery plans, refused commands…) need you too. Its own jobs aren't groups:
// the summary next to it says what they do.
export function requestProgress(r: RequestState, ctx: RenderContext): Progress {
  const p: Progress = { "needs you": 0, working: 0, ready: 0, pending: 0, closed: 0 };
  for (const i of Object.values(r.items)) {
    p[itemBucket(r, i, ctx)]++;
  }
  p["needs you"] += r.needsUser.filter((n) => flagItemOf(r, n) === undefined).length + refusedOf(r).length;
  return p;
}

// A recover run started by what you typed says so; its purpose keeps the text.
export function workLabel(j: JobView): Html {
  const said = j.name === "recover" ? j.purpose?.reason : undefined;
  return said ? html`working on <span class="said" title="${said}">“${said.split("\n")[0]}”</span>` : html`${jobLabel(j.name)}`;
}

// A bar with one segment per bucket, then "2 need you · 1 working · 3 ready · 4 pending · 5 closed".
export function progressLine(p: Progress): Html {
  const shown = BUCKETS.filter((b) => p[b] > 0);
  if (!shown.length) {
    return html`<span class="sub">nothing to work on yet</span>`;
  }
  const cls = (b: Bucket) => b.replace(" ", "-");
  return html`<span class="pbar">${shown.map((b) => html`<span class="${cls(b)}" style="flex-grow:${p[b]}"></span>`)}</span>${join(
    shown.map((b) => html`<span class="${cls(b)}">${p[b]} ${b === "needs you" && p[b] === 1 ? "needs you" : b === "needs you" ? "need you" : b}</span>`),
    " · ",
  )}`;
}

export function sumProgress(list: Progress[]): Progress {
  const sum: Progress = { "needs you": 0, working: 0, ready: 0, pending: 0, closed: 0 };
  for (const p of list) {
    for (const b of BUCKETS) {
      sum[b] += p[b];
    }
  }
  return sum;
}
