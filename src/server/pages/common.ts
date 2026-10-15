import type { BugDraft, ItemState, ItemView, NeedsUser, PatchView, PushView, RequestState, StackView } from "../../types.ts";
import { REQUEST_STEPS } from "../commands.ts";
import { html, type Html } from "../html.ts";

// What the pages need besides the state.
export interface RenderContext {
  profilerOrigin: string;
  baseUrl: string; // how the browser reaches this server, e.g. "http://host:4300"
  now: number; // ms, for running durations
  maxAgents?: number;
  maxBuilds?: number;
  open?: string; // request id to show expanded
  // The text of a patch's interdiffFile, read by the server inside stateDir.
  interdiff?: (p: PatchView) => string | undefined;
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

// What became of text from the main box that didn't become a request of its own: forwarded, or
// route-request failed and its ⚑ asks you to rephrase it.
export function routeOutcome(r: RequestState): string {
  return r.forwardedTo ? `Forwarded to ${r.forwardedTo}` : (r.needsUser.at(-1)?.action ?? "");
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

export function enterBugUrl(d: BugDraft): string {
  const p = new URLSearchParams({ product: d.product, component: d.component, short_desc: d.summary, comment: d.description });
  if (d.blocks?.length) {
    p.set("blocked", d.blocks.join(","));
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
  const noBug = patches.filter((p) => p.bug === null).length;
  const pushes = Object.values(r.pushes);
  const tryDone = pushes.length > 0 && pushes.every((p) => p.result === "green");
  return [
    { ok: wip === 0, text: wip === 0 ? "no WIP/DEBUG" : `${wip} WIP/DEBUG patches` },
    { ok: tryDone, text: tryDone ? "try complete and green" : pushes.length === 0 ? "no try push" : "try not complete and green" },
    { ok: noReviewer === 0, text: noReviewer === 0 ? "r= on every patch" : `${noReviewer} patches without r=` },
    { ok: noBug === 0, text: noBug === 0 ? "every patch has a bug" : `${noBug} ${noBug === 1 ? "patch still says" : "patches still say"} Bug XXXXXXX` },
  ];
}

export function stackOfPatch(r: RequestState, patch: string | undefined): StackView | undefined {
  return patch === undefined ? undefined : Object.values(r.stacks).find((s) => s.order.includes(patch));
}

export type ActionKind = "approve-push" | "take-it" | "file-bug" | "meta-bug" | "submit" | "resubmit" | "land" | "recovery" | "other";
const ACTION_KINDS: ActionKind[] = ["approve-push", "take-it", "file-bug", "meta-bug", "submit", "resubmit", "land", "recovery"];

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
  if (patch && patch.bug === null && patch.bugDraft) {
    return "file-bug";
  }
  if (n.item) {
    return "take-it";
  }
  return "other";
}

export function pushStatus(p: PushView): string {
  if (p.result) {
    return p.result === "green" ? "green" : p.summary || "failures";
  }
  if (p.progress) {
    return `${p.progress.done}/${p.progress.total}, ${plural(p.progress.failures, "failure")}`;
  }
  return p.rev ? "pushed" : "planned";
}

export function pushResultClass(p: PushView): "ok" | "bad" | "run" {
  return p.result ? (p.result === "green" ? "ok" : "bad") : "run";
}

// Only https links from the state: anything else (javascript:, data:) falls back
// on Treeherder.
export function pushUrl(p: PushView): string {
  if (p.url && /^https:\/\//i.test(p.url) && URL.canParse(p.url)) {
    return p.url;
  }
  return TREEHERDER + encodeURIComponent(p.rev ?? "");
}

export type StateClass = "run" | "wait" | "find" | "ok" | "closed";

export function stateClass(s: ItemState): StateClass {
  switch (s) {
    case "investigating":
    case "in critical review":
    case "addressing review comments":
    case "in stack":
    case "in try":
      return "run";
    case "not started":
    case "waiting for a build slot":
    case "waiting for review":
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

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatCost(usd: number): string {
  return `$${usd < 10 ? usd.toFixed(2) : Math.round(usd)}`;
}

export function requestCost(r: RequestState): number {
  return Object.values(r.jobs).reduce((sum, j) => sum + (j.costUsd ?? 0), 0);
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
