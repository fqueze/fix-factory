// What each group is doing, in plain words, and what a request (or the whole factory) is doing: working,
// waiting for you, or done. No internal state names.
import { isPushJob } from "../../state/flags.ts";
import type { ItemState, ItemView, JobView, RequestState } from "../../types.ts";
import { html, join, type Html } from "../html.ts";
import { continueBox, flagControls, flagText, hasAuthorSession } from "./actions.ts";
import { elapsed, groupLabel, jobLabel, jobNoun, modelLabel, refusedOf, requestUrl, type RenderContext, type StateClass } from "./common.ts";

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
}

export function runningJobOf(r: RequestState, i: ItemView): JobView | undefined {
  return i.jobs.map((j) => r.jobs[j]).findLast((j) => j.endedAt === undefined);
}

export function itemSentence(r: RequestState, i: ItemView, ctx: RenderContext): ItemSentence {
  const job = runningJobOf(r, i);
  if (job) {
    return { text: html`${runningSentence(job)} · ${elapsed(job.startedAt, ctx)}`, cls: "run", controls: null, detail: i.detail };
  }
  const flag = r.needsUser.find((n) => n.item === i.id);
  if (flag) {
    return { text: html`stuck: ${flagText(r, flag)} — needs you`, cls: "find", controls: flagControls(r, flag), detail: flag.key.startsWith("stopped:") ? undefined : flag.detail };
  }
  const idle = IDLE[i.state];
  if (idle.active) {
    // At the agent cap, next() is only waiting for a slot.
    if (ctx.maxAgents !== undefined && ctx.runningAgents !== undefined && ctx.runningAgents >= ctx.maxAgents) {
      return { text: html`waiting for an agent (${ctx.runningAgents}/${ctx.maxAgents} running)`, cls: "wait", controls: null, detail: i.detail };
    }
    return { text: html`${stalledText(r, i)}`, cls: "find", controls: stalledControls(r, i), detail: i.detail };
  }
  const builds = ctx.runningBuilds ?? Object.values(r.jobs).filter((j) => j.kind === "build" && j.endedAt === undefined).length;
  return { text: html`${idle.text(i, builds)}`, cls: DONE.includes(i.state) ? (i.state === "fixed" || i.state === "landed" ? "ok" : "closed") : "wait", controls: null, detail: i.detail };
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

function stalledControls(r: RequestState, i: ItemView): Html | null {
  const back = requestUrl(r.id);
  const last = i.jobs.map((j) => r.jobs[j]).at(-1);
  const retry =
    last && last.exitCode !== 0 && !isPushJob(last)
      ? html`<form class="inline cmd" method="post" action="/api/commands"><input type="hidden" name="command" value="${JSON.stringify({ cmd: "retry", job: last.job, request: r.id })}"><input type="hidden" name="back" value="${back}"><button class="btn small" title="Runs ${jobNoun(last.name)} again">Retry</button></form>`
      : null;
  const talk = hasAuthorSession(r, i.id) ? continueBox(r.id, i.id, back) : null;
  return retry || talk ? html`${retry}${talk}` : null;
}

// One running thing: a group with a job, or a job of the request itself.
export interface Work {
  who?: string; // the group, absent for the request's own jobs
  what: Html;
  startedAt: string;
}

export interface Progress {
  working: Work[];
  waiting: number;
  done: number;
}

export function requestProgress(r: RequestState): Progress {
  const working: Work[] = [];
  for (const i of Object.values(r.items)) {
    const job = runningJobOf(r, i);
    if (job) {
      working.push({ who: groupLabel(r, i), what: html`${runningSentence(job)}`, startedAt: job.startedAt });
    }
  }
  for (const j of Object.values(r.jobs).filter((x) => x.item === undefined && x.endedAt === undefined)) {
    working.push({ what: workLabel(j), startedAt: j.startedAt });
  }
  return {
    working,
    waiting: r.needsUser.length + refusedOf(r).length,
    done: Object.values(r.items).filter((i) => DONE.includes(i.state)).length,
  };
}

// A recover run started by what you typed says so; its purpose keeps the text.
export function workLabel(j: JobView): Html {
  const said = j.name === "recover" ? j.purpose?.reason : undefined;
  return said ? html`working on <span class="said" title="${said}">“${said.split("\n")[0]}”</span>` : html`${jobLabel(j.name)}`;
}

const SHOWN_WORK = 3;

// "Working: 2 (browser_a.js: being reviewed by Opus, 1 min; …) · Waiting for you: 1 · Done: 3"
export function progressLine(p: Progress, ctx: RenderContext): Html {
  const shown = p.working.slice(0, SHOWN_WORK).map((w) => html`${w.who ? `${w.who}: ` : ""}${w.what}, ${elapsed(w.startedAt, ctx)}`);
  const more = p.working.length - shown.length;
  return html`<span class="${p.working.length ? "busy" : "idle"}">Working: ${p.working.length}${
    shown.length ? html` (${join(shown, "; ")}${more > 0 ? `; ${more} more` : ""})` : null
  }</span> · <span class="${p.waiting ? "waiting" : ""}">Waiting for you: ${p.waiting}</span> · Done: ${p.done}`;
}

export function sumProgress(list: Progress[]): Progress {
  return { working: list.flatMap((p) => p.working), waiting: list.reduce((n, p) => n + p.waiting, 0), done: list.reduce((n, p) => n + p.done, 0) };
}
