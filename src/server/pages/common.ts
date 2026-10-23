import { basename } from "node:path";
import type { BugDraft, Command, ItemState, ItemView, NeedsUser, PatchView, PushView, RefusedCommand, Regression, RequestState, StackView } from "../../types.ts";
import { REQUEST_STEPS } from "../commands.ts";
import { html, join, type Html } from "../html.ts";
import { needsMetaBug as stackNeedsMetaBug } from "../../state/meta-bug.ts";

// What the pages need besides the state.
export interface RenderContext {
  profilerOrigin: string;
  baseUrl: string; // how the browser reaches this server, e.g. "http://host:4300"
  now: number; // ms, for running durations
  maxAgents?: number;
  maxBuilds?: number;
  runningBuilds?: number; // across requests, for "waiting for a build slot (N builds running)"
  runningAgents?: number; // across requests, for "waiting for an agent (N/M running)"
  open?: string[]; // ids of the requests to show expanded
  bugzillaEmail?: string; // bugs to file are assigned to you
  // The text of a patch's interdiffFile, read by the server inside stateDir.
  interdiff?: (p: PatchView) => string | undefined;
  // A file the factory wrote, by its path relative to stateDir (an interdiff since a push).
  readData?: (rel: string) => string | undefined;
  freeDiskGB?: number; // where the worktrees go
}

export const PHABRICATOR = "https://phabricator.services.mozilla.com";
export const BUGZILLA = "https://bugzilla.mozilla.org";
export const TREEHERDER = "https://treeherder.mozilla.org/jobs?repo=try&revision=";

export type Section = "active" | "queued" | "finished";

export function sectionOf(r: RequestState): Section {
  if (r.step === "done") {
    return "finished";
  }
  if (r.step === "request" && Object.keys(r.jobs).length === 0) {
    return "queued";
  }
  return "active";
}

export function requestName(r: RequestState): string {
  if (r.kind === "burndown" && r.folder) {
    return `Flakiness burndown: ${r.folder}`;
  }
  const firstLine = r.text.split("\n")[0].trim();
  if (firstLine) {
    return firstLine;
  }
  return r.rev ? `Fix the failures of try push ${r.rev}` : r.id;
}

// What became of text from the main box that didn't become a request of its own: forwarded to the
// request it was about, or superseded by its rephrasing after route-request failed.
export function routeOutcome(r: RequestState): string {
  return r.forwardedTo ? `Forwarded to ${r.forwardedTo}` : `Superseded by ${r.supersededBy}`;
}

// "r-20261015-xpcshell-cwd" → "xpcshell-cwd", for tight columns.
export function shortName(r: RequestState): string {
  return r.id.replace(/^r-\d{8}-/, "");
}

export function stepLabel(r: RequestState): string {
  return r.step === "done" ? "done" : `${REQUEST_STEPS.indexOf(r.step) + 1} · ${r.step}`;
}

export function requestUrl(id: string): string {
  return `/requests/${encodeURIComponent(id)}`;
}

export function profileUrl(ctx: RenderContext, id: string): string {
  const url = `${ctx.baseUrl}/api/requests/${encodeURIComponent(id)}/profile`;
  return `${ctx.profilerOrigin}/from-url/${encodeURIComponent(url)}?thread=0`;
}

export function phabUrl(revision: number, inline?: number): string {
  return `${PHABRICATOR}/D${revision}${inline === undefined ? "" : `#inline-${inline}`}`;
}

export function bugUrl(bug: number): string {
  return `${BUGZILLA}/show_bug.cgi?id=${bug}`;
}

// The meta bug's form: it depends on every bug of the stacks' patches.
export function metaBugUrl(r: RequestState, draft: BugDraft, ctx: RenderContext): string {
  const bugs = [...new Set(Object.values(r.stacks).flatMap((s) => stackPatches(r, s)).flatMap((p) => (p.bug !== null && p.bug !== 0 ? [p.bug] : [])))];
  return enterBugUrl({ ...draft, dependsOn: bugs }, ctx);
}

// Assigned to you when you have a Bugzilla email: its patches are yours.
export function enterBugUrl(d: BugDraft, ctx: RenderContext): string {
  const p = new URLSearchParams({ product: d.product, component: d.component, short_desc: d.summary, comment: d.description });
  if (ctx.bugzillaEmail) {
    p.set("assigned_to", ctx.bugzillaEmail);
    p.set("bug_status", "ASSIGNED");
  }
  if (d.blocks?.length) {
    p.set("blocked", d.blocks.join(","));
  }
  if (d.dependsOn?.length) {
    p.set("dependson", d.dependsOn.join(","));
  }
  if (d.bugType) {
    p.set("bug_type", d.bugType);
  }
  if (d.keywords?.length) {
    p.set("keywords", d.keywords.join(","));
  }
  return `${BUGZILLA}/enter_bug.cgi?${p}`;
}

// The commit title without its "Bug N - " prefix, which the bug column shows.
export function patchTitle(p: PatchView): string {
  return p.title.replace(/^Bug (\d+|X+)\s*-\s*/i, "");
}

export function itemOf(r: RequestState, p: PatchView): ItemView | undefined {
  return p.item ? r.items[p.item] : undefined;
}

// Bug 0 is what a commit message with a placeholder bug number parses to.
export function hasBug(p: { bug: number | null }): p is { bug: number } {
  return p.bug !== null && p.bug !== 0;
}

// The patch of a group that was left as-is or handed back, or that its author dropped from its fix: not part of the
// work anymore.
export function isDropped(r: RequestState, p: PatchView): boolean {
  const item = itemOf(r, p);
  if (item === undefined) return false;
  const index = p.id === `p-${item.id.replace(/^i-/, "")}` ? 0 : Number(p.id.slice(`p-${item.id.replace(/^i-/, "")}-`.length)) - 1;
  return stateClass(item.state) === "closed" || (item.commitCount !== undefined && index >= item.commitCount);
}

const REVIEWED_OR_LATER: ItemState[] = ["reviewed", "in stack", "in try", "waiting for review", "addressing review comments", "fixed", "landed"];

// An author commit whose critical review hasn't passed (its item still in progress, or blocked):
// it shows on its group row only, without a bug to file.
export function isDraft(r: RequestState, p: PatchView): boolean {
  const item = itemOf(r, p);
  return item !== undefined && stateClass(item.state) !== "closed" && !REVIEWED_OR_LATER.includes(item.state);
}

export function isLanded(r: RequestState, p: PatchView): boolean {
  return itemOf(r, p)?.state === "landed";
}

export function isAccepted(p: PatchView): boolean {
  const active = p.review?.reviewers.filter((x) => x.status !== "resigned") ?? [];
  return active.length > 0 && active.every((x) => x.status === "accepted");
}

// Accepted, and every hard dep is landed or landable itself.
export function isLandable(r: RequestState, p: PatchView, seen = new Set<string>()): boolean {
  if (!isAccepted(p) || isLanded(r, p) || seen.has(p.id)) {
    return false;
  }
  seen.add(p.id);
  return p.deps
    .filter((d) => d.kind === "hard")
    .every((d) => {
      const needed = r.patches[d.needs];
      return needed !== undefined && (isLanded(r, needed) || isLandable(r, needed, seen));
    });
}

export function stackPatches(r: RequestState, s: StackView): PatchView[] {
  return s.order.map((id) => r.patches[id]).filter((p) => p !== undefined);
}

export function patchesOutsideStacks(r: RequestState): PatchView[] {
  const stacked = new Set(Object.values(r.stacks).flatMap((s) => s.order));
  return Object.values(r.patches).filter((p) => !stacked.has(p.id));
}

export interface Check {
  ok: boolean;
  text: string;
}

// The pre-submit checks the page can tell from the state (stack.ts check is the
// real gate; this shows you why the submit button is disabled).
export function submitChecks(r: RequestState, s: StackView): Check[] {
  const patches = stackPatches(r, s).filter((p) => !isLanded(r, p));
  const wip = patches.filter((p) => /^(WIP|DEBUG)\b/i.test(p.title) || /DO NOT LAND/i.test(p.title)).length;
  const noReviewer = patches.filter((p) => !/\br=\S/.test(p.title)).length;
  const noBug = patches.filter((p) => !hasBug(p)).length;
  // The stack's verification pushes that were made: not the initial, un-skip or repro pushes, nor another stack's,
  // nor those declined.
  const otherStack = (p: PushView) => Object.values(r.jobs).some((j) => j.purpose?.push === p.id && j.purpose.stack !== undefined && j.purpose.stack !== s.id);
  const pushes = Object.values(r.pushes).filter((p) => p.rev && !/^(initial|unskip|repro-)/.test(p.id) && !otherStack(p));
  const tryDone = pushes.length > 0 && pushes.every((p) => p.result === "green");
  return [
    { ok: wip === 0, text: wip === 0 ? "no WIP/DEBUG" : `${wip} WIP/DEBUG patches` },
    { ok: tryDone, text: tryDone ? "try complete and green" : pushes.length === 0 ? "no try push" : "try not complete and green" },
    { ok: noReviewer === 0, text: noReviewer === 0 ? "r= on every patch" : `${noReviewer} patches without r=` },
    { ok: noBug === 0, text: noBug === 0 ? "every patch has a bug" : `${noBug} ${noBug === 1 ? "patch still says" : "patches still say"} Bug XXXXXXX` },
  ];
}

// The meta-bug comment is offered when the stack gets a meta bug, or one was filed already.
export function needsMetaBug(r: RequestState, s: StackView): boolean {
  return r.metaBug !== undefined || stackNeedsMetaBug(stackPatches(r, s));
}

export function stackOfPatch(r: RequestState, patch: string | undefined): StackView | undefined {
  return patch === undefined ? undefined : Object.values(r.stacks).find((s) => s.order.includes(patch));
}

// Folded states saved before refused existed don't have it.
export function refusedOf(r: RequestState): RefusedCommand[] {
  return r.refused ?? [];
}

export function needsYou(r: RequestState): boolean {
  return r.needsUser.length > 0 || refusedOf(r).length > 0;
}

// Refused commands name theirs in plain words.
export const COMMAND_LABELS: Record<Command["cmd"], string> = {
  "approve-push": "try push approval",
  "decline-push": "declining a try push",
  "copied-submit": "copying the moz-phab command",
  "copied-reorg": "copying the moz-phab reorg command",
  presence: "presence",
  "set-bug": "bug number",
  "comment-bug-draft": "comment on the bug draft",
  "stack-comments": "stack-viewer comments",
  "redo-annotations": "redo the skip-ifs group",
  "poll-phab": "check Phabricator now",
  "revise-push": "revise the push",
  "take-it": "take it",
  "hand-back": "close",
  "comment-fix": "comment on the fix",
  "set-test-plan": "setting the test plan on Phabricator",
  "revise-test-plan": "revising the test plan",
  "tell-factory": "message to the factory",
  "reply-recovery": "reply to the recovery plan",
  "start-now": "start now",
  "retry-job": "retry",
  "cancel-job": "stop",
  "resume-agent": "message to the author",
  "start-agent": "restart of the investigation",
  "set-state": "state change",
  "redo-step": "redo step",
  "edit-config": "config change",
  shell: "shell command",
  "accept-review": "accept as reviewed",
  "allow-push": "one try push allowed",
  continue: "continue",
  retry: "retry",
  stop: "stop",
  dismiss: "dismiss",
};

export type ActionKind = "approve-push" | "take-it" | "file-bug" | "meta-bug" | "submit" | "resubmit" | "land" | "recovery" | "failed" | "stopped" | "disagrees" | "other";
const ACTION_KINDS: ActionKind[] = ["approve-push", "take-it", "file-bug", "meta-bug", "submit", "resubmit", "land", "recovery", "failed", "stopped", "disagrees"];

// The key's "<kind>:" prefix names the buttons of a needs-user entry, and the ids
// it carries (push, item, patch, stack, job) say what they act on. Entries with
// another key get their buttons from those ids alone.
export function actionKind(n: NeedsUser, r: RequestState): ActionKind {
  const prefix = n.key.split(":")[0];
  if ((ACTION_KINDS as string[]).includes(prefix)) {
    return prefix as ActionKind;
  }
  if (n.push) {
    return "approve-push";
  }
  if (n.job) {
    return "recovery";
  }
  const patch = n.patch ? r.patches[n.patch] : undefined;
  if (patch && !hasBug(patch) && patch.bugDraft) {
    return "file-bug";
  }
  return "other";
}

// A push by what it's for, numbered in order among those for the same thing: verify-stack (the whole stack),
// verify-fixes (the stack again after an earlier push of it), debug-<test> or check-<test> (what a group's author
// asked for), unskip, initial. Its id stays what the factory keys it by.
export function pushName(r: RequestState, id: string): string {
  const ids = Object.keys(r.pushes);
  const base = pushKind(r, id);
  // One the factory can't tell the purpose of keeps its id.
  if (base === undefined || base === "initial") return base ?? id;
  return `${base}-${ids.filter((x) => pushKind(r, x) === base).indexOf(id) + 1}`;
}

function pushKind(r: RequestState, id: string): string | undefined {
  const p = r.pushes[id];
  if (id === "initial") return "initial";
  if (id.startsWith("unskip")) return "unskip";
  const stack = Object.values(r.jobs).find((j) => j.purpose?.what === "dry-run" && j.purpose.push === id)?.purpose?.stack;
  if (stack !== undefined) {
    const name = Object.keys(r.stacks).length > 1 ? `verify-${stack}` : "verify";
    // After a push of the stack that was made, it verifies fixes.
    const ids = Object.keys(r.pushes);
    const earlier = ids.slice(0, ids.indexOf(id)).some((x) => r.pushes[x].rev && Object.values(r.jobs).some((j) => j.purpose?.what === "dry-run" && j.purpose.push === x && j.purpose.stack === stack));
    return `${name}-${earlier ? "fixes" : "stack"}`;
  }
  const ask = id.indexOf("-ask-");
  if (ask < 0 && !id.startsWith("repro-")) return undefined;
  const debug = /\b(debug|reproduce|repro|log|logging|profile)\b/i.test(p?.purpose ?? "") || id.startsWith("repro-");
  const item = ask < 0 ? undefined : Object.values(r.items).find((i) => i.id.replace(/^i-/, "").slice(0, 24) === id.slice(0, ask));
  const test = item?.group.tests[0]?.split("/").pop()?.replace(/\.[^.]+$/, "");
  return `${debug ? "debug" : "check"}${test ? `-${test}` : ""}`;
}

export function pushStatus(p: PushView): string {
  if (p.result) {
    return p.result === "green" ? "green" : p.summary || "failures";
  }
  if (p.progress) {
    const t = p.progress.tests;
    return `${t ? `${t.done}/${t.total} test tasks` : `${p.progress.done}/${p.progress.total}`}, ${plural(p.progress.failures, "failure")}`;
  }
  return p.rev ? "pushed" : "planned";
}

export function pushResultClass(p: PushView): "ok" | "bad" | "run" {
  return p.result ? (p.result === "green" ? "ok" : "bad") : "run";
}

// Only https links from the state: anything else (javascript:, data:) falls back
// on Treeherder.
// Treeherder's job view also showing the jobs not scheduled yet, waiting for their builds.
const RESULT_STATUS = "unscheduled,testfailed,busted,exception,success,retry,usercancel,running,pending,runnable";

export function pushUrl(p: PushView): string {
  const url = new URL(p.url && /^https:\/\//i.test(p.url) && URL.canParse(p.url) ? p.url : TREEHERDER + encodeURIComponent(p.rev ?? ""));
  if (url.host === "treeherder.mozilla.org" && url.pathname === "/jobs") {
    url.searchParams.set("resultStatus", RESULT_STATUS);
  }
  return url.href;
}

export type StateClass = "run" | "wait" | "find" | "ok" | "closed";

export function stateClass(s: ItemState): StateClass {
  switch (s) {
    case "investigating":
    case "in critical review":
    case "addressing review comments":
      return "run";
    case "in stack":
    case "in try":
    case "not started":
    case "waiting for a build slot":
    case "waiting for review":
    case "waiting for a try repro":
      return "wait";
    case "review findings":
    case "blocked":
      return "find";
    case "fix verified locally":
    case "reviewed":
    case "fixed":
    case "landed":
      return "ok";
    case "left as-is":
    case "handed back":
      return "closed";
  }
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s} s`;
  }
  const min = Math.round(s / 60);
  if (min < 60) {
    return `${min} min`;
  }
  const h = ms / 3_600_000;
  return h < 10 ? `${h.toFixed(1).replace(/\.0$/, "")} h` : `${Math.round(h)} h`;
}

// A running duration; client.js keeps it ticking between page updates.
export function elapsed(startedAt: string, ctx: RenderContext): Html {
  return html`<span data-since="${startedAt}">${formatDuration(ctx.now - Date.parse(startedAt))}</span>`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatCost(usd: number): string {
  return `$${usd < 10 ? usd.toFixed(2) : Math.round(usd)}`;
}

export function requestCost(r: RequestState): number {
  return Object.values(r.jobs).reduce((sum, j) => sum + (j.costUsd ?? 0), 0);
}

// Test paths are long and share the request's folder: show what follows it.
function relativePath(path: string, folder: string | undefined): string {
  return folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
}

// "browser_foo.js", "sub/browser_foo.js, browser_bar.js", or the subfolder and test count of a larger group.
export function groupLabel(r: RequestState, i: ItemView): string {
  const tests = i.group.tests;
  if (tests.length <= 3) {
    return tests.map((t) => relativePath(t, r.folder)).join(", ");
  }
  const folder = i.folder === r.folder ? "" : relativePath(i.folder, r.folder);
  return `${folder ? `${folder}, ` : ""}${tests.length} tests`;
}

// Bug numbers, revisions and the given tests (by full path or file name) of a text, as links.
export function linkify(text: string, tests: string[] = []): Html {
  const byName = new Map(tests.flatMap((t) => [[t, t], [basename(t), t]]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`\\b([Bb]ug (\\d{5,8}))\\b|\\b(D(\\d{5,7}))\\b${names.length ? `|(${names.join("|")})` : ""}`, "g");
  const parts: Html[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(html`${text.slice(last, m.index)}`);
    const href = m[1] ? `${BUGZILLA}/show_bug.cgi?id=${m[2]}` : m[3] ? `${PHABRICATOR}/${m[3]}` : `https://tests.firefox.dev/test.html?test=${encodeURIComponent(byName.get(m[5])!)}`;
    parts.push(html`<a href="${href}" target="_blank" rel="noopener">${m[0]}</a>`);
    last = m.index + m[0].length;
  }
  parts.push(html`${text.slice(last)}`);
  return join(parts, "");
}

// The same, each test linked to its dashboard on tests.firefox.dev (manifests aren't tests).
export function groupLinks(r: RequestState, i: ItemView): Html {
  const tests = i.group.tests;
  if (tests.length > 3) {
    return html`${groupLabel(r, i)}`;
  }
  return join(
    tests.map((t) =>
      /\.(toml|ini)$/.test(t)
        ? html`${relativePath(t, r.folder)}`
        : html`<a href="https://tests.firefox.dev/test.html?test=${encodeURIComponent(t)}" target="_blank" rel="noopener" title="Its failures on tests.firefox.dev">${relativePath(t, r.folder)}</a>`,
    ),
    ", ",
  );
}

// Job names are a tool and its first argument, or a prompt name.
const JOB_LABELS: Record<string, string> = {
  "annotations.ts list": "list skip annotations",
  "artifacts.ts fetch": "fetch test artifacts",
  "bugzilla.ts prior-art": "search prior art",
  "failures.ts try-table": "read try results",
  "failures.ts collect": "collect failures",
  "failures.ts cluster": "cluster failures",
  "git checkout": "check out the stack",
  "git log": "read commit message",
  "lint-text.ts commit": "lint message",
  "lint-text.ts bug": "lint bug draft",
  "lint-text.ts reply": "lint reply",
  "phab.ts poll": "poll Phabricator",
  "phab.ts reviewers": "pick reviewers",
  "stack.ts assemble": "assemble stack",
  "stack.ts check": "check stack",
  "stack.ts deps": "find dependencies",
  "stack.ts import": "import commits",
  "stack.ts interdiff": "interdiff",
  "stack.ts order": "order stack",
  "stack.ts rewrite": "rewrite stack",
  "stack.ts summary": "meta-bug comment",
  "try.ts dry-run": "try dry run",
  "try.ts push": "push to try",
  "try.ts watch": "watch try push",
  "worktree.ts create": "build worktree",
  "worktree.ts remove": "remove worktree",
  shell: "shell command",
  "adapt-soft-dep": "adapt to a soft dep",
  "address-review": "address review comments",
  "classify-annotation": "classify annotation",
  "classify-review-comments": "classify review comments",
  "estimate-review-effort": "estimate review effort",
  "investigate-and-fix": "investigate",
  "merge-clusters": "merge clusters",
  "plan-try-pushes": "plan try pushes",
  "prior-art-verdict": "judge prior art",
  recover: "answering you",
  "resolve-conflict": "resolve conflict",
  "review-patch": "critical review",
  "review-stack": "review stack",
  "revise-bug-draft": "revise bug draft",
  "route-request": "route request",
  "triage-try": "triage try results",
  "write-annotation-patches": "write annotation patches",
};

export function jobLabel(name: string): string {
  // Older jobs have the tool's flags in their names too.
  return JOB_LABELS[name] ?? JOB_LABELS[name.split(" ").slice(0, 2).join(" ")] ?? name;
}

// A job as the subject of a sentence ("the investigation stopped by you").
export function jobNoun(name: string): string {
  return name === "investigate-and-fix" ? "the investigation" : jobLabel(name);
}

export function modelLabel(model: string): string {
  return model.charAt(0).toUpperCase() + model.slice(1);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Hidden fields of a command form: the command's JSON, and where to come back to
// when the page is used without its script.
export function commandFields(commands: object[], back: string): Html {
  return html`${commands.map((c) => html`<input type="hidden" name="command" value="${JSON.stringify(c)}">`)}<input type="hidden" name="back" value="${back}">`;
}

export const PHAB_ICON = html`<svg><use href="#phab"/></svg>`;

// A regression's status; plans from before it was reported: fixed when a patch claims it, gone when the patch that
// caused it left the stack.
export function regressionStatus(r: RequestState, g: Regression): NonNullable<Regression["status"]> {
  return g.status ?? (g.fixedBy ? "fixed" : g.causedBy && !Object.values(r.stacks).some((st) => st.order.includes(g.causedBy!)) ? "patch removed" : "not fixed");
}
