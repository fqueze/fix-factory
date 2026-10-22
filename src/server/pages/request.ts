import { ANNOTATIONS_ITEM, needsMetaBug as stackNeedsMetaBug } from "../../state/meta-bug.ts";
import { md } from "./md.ts";
import { REQUEST_STEPS } from "../commands.ts";
import type { BugDraft, ItemView, JobView, PatchView, PushView, RequestState, StackView } from "../../types.ts";
import { html, join, type Html } from "../html.ts";
import { actionsSummary, recoveryAnswers, pollPhabButton, redoAnnotationsButton, approvePushControls, bugBox, continueBox, copyButton, handBackButton, flagControls, flagItemOf, flagText, plannedLabel, recoveryPlanFor, hasAuthorSession, stackViewerLink, submitControls, summaryId } from "./actions.ts";
import { groupJobs, jobLine } from "./activity.ts";
import { flagAsk, itemBucket, itemSentence, progressLine, requestProgress, type Bucket } from "./progress.ts";
import {
  actionKind,
  bugUrl,
  commandFields,
  elapsed,
  enterBugUrl,
  metaBugUrl,
  formatCost,
  formatDate,
  groupLabel,
  groupLinks,
  hasBug,
  isDraft,
  isDropped,
  isLandable,
  jobLabel,
  itemOf,
  needsMetaBug,
  needsYou,
  plural,
  patchTitle,
  phabUrl,
  PHAB_ICON,
  profileUrl,
  pushName,
  pushStatus,
  requestCost,
  requestName,
  requestUrl,
  routeOutcome,
  sectionOf,
  stackPatches,
  stateClass,
  pushResultClass,
  pushUrl,
  type RenderContext,
  type StateClass,
} from "./common.ts";

// One line per request; the body only when expanded, so the overview stays small.
export function renderRequest(r: RequestState, ctx: RenderContext, open = ctx.open?.includes(r.id) ?? false): Html {
  const needs = needsYou(r);
  const cost = requestCost(r);
  const summary = requestSummary(r);
  return html`<details class="req${needs ? " needs" : ""}" id="req-${r.id}" data-request="${r.id}" data-section="${sectionOf(r)}"${open ? html` open` : null}>
    <summary>
      <span class="rname">${requestName(r)}</span>
      <span class="rsum"><span class="rprog">${progressLine(requestProgress(r, ctx))}</span>${summary ? ` · ${summary}` : null}</span>
      <span class="rright">${cost > 0 ? html`<span class="hide-sm" title="What the agents of this request cost so far">${formatCost(cost)} spent</span>` : null}<a class="btn small" href="${profileUrl(ctx, r.id)}" target="_blank" rel="noopener">Profile</a></span>
      ${actionsSummary(r, ctx)}
    </summary>
    ${open ? renderRequestBody(r, ctx) : html`<div class="rbody" data-lazy><a href="${requestUrl(r.id)}">Open this request</a></div>`}
  </details>`;
}

// What the progress bar of its groups doesn't say: what became of unrouted text, the config being written, what the
// request's own jobs do, try.
export function requestSummary(r: RequestState): string {
  const parts: string[] = [];
  if (r.kind === "unrouted") {
    parts.push(r.step === "done" ? routeOutcome(r) : "not routed yet: a new request, or about an existing one?");
  } else if (r.step === "request") {
    const keys = configEntries(r).map(([k]) => k);
    parts.push(keys.length ? `config: ${keys.join(", ")}` : "turning the request into a config");
  }
  const own = Object.values(r.jobs).filter((j) => j.item === undefined && j.endedAt === undefined && j.purpose?.push === undefined);
  parts.push(...new Set(own.map((j) => jobLabel(j.name))));
  // Once submitted, where its revisions stand says more than try.
  const submitted = Object.values(r.patches).filter((p) => p.revision !== undefined && !isDropped(r, p));
  // Done, everything landed: its groups' count says it.
  if (submitted.length && r.step !== "done" && REQUEST_STEPS.indexOf(r.step) >= REQUEST_STEPS.indexOf("review comments")) {
    const label = (status: string) => ({ "needs-review": "waiting for review", accepted: "accepted", "needs-revision": "changes requested", published: "landed" })[status] ?? status;
    const counts = new Map<string, number>();
    for (const p of submitted) counts.set(label(p.review?.status ?? "needs-review"), (counts.get(label(p.review?.status ?? "needs-review")) ?? 0) + 1);
    parts.push(`on Phabricator: ${[...counts].map(([l, n]) => (counts.size === 1 && n === submitted.length ? l : `${n} ${l}`)).join(", ")}`);
    return parts.join(" · ");
  }
  if (r.step === "done") return parts.join(" · ");
  // Declined pushes say nothing about try; the last one made does, or one waiting for you.
  const pushes = Object.values(r.pushes).filter((p) => p.declined === undefined);
  const running = pushes.filter((p) => p.rev && p.result === undefined);
  const last = pushes.filter((p) => p.rev).at(-1) ?? pushes.at(-1);
  if (running.length > 1) {
    const sum = (k: "done" | "total" | "failures") => running.reduce((n, p) => n + (p.progress?.[k] ?? 0), 0);
    parts.push(`try: ${running.length} pushes, ${sum("done")}/${sum("total")}, ${plural(sum("failures"), "failure")}`);
  } else if (last) {
    parts.push(`try: ${pushStatus(last)}`);
  }
  return parts.join(" · ");
}

export function renderRequestBody(r: RequestState, ctx: RenderContext): Html {
  const back = requestUrl(r.id);
  // A landed patch leaves its stack, for the Landed section; a stack with nothing left isn't shown.
  const stacks = Object.values(r.stacks).filter((s) => livePatches(r, s).length > 0);
  const stacked = new Set(Object.values(r.stacks).flatMap((s) => s.order));
  const stackedItems = new Set(stacks.flatMap((s) => livePatches(r, s).map((p) => p.item)));
  // Patches without a group (annotation patches) get a row of their own.
  const loose = Object.values(r.patches).filter((p) => !stacked.has(p.id) && itemOf(r, p) === undefined);
  const unstacked = Object.values(r.items).filter((i) => !stackedItems.has(i.id));
  // Groups whose patches landed have left their stack.
  const metaSummary = r.metaBug?.draft?.summary ?? "";
  // The abandoned groups come last, after what landed.
  const own = (i: ItemView) => Object.values(r.patches).filter((p) => p.item === i.id && !isDropped(r, p));
  const landed = unstacked.filter((i) => i.state === "landed" || (own(i).length > 0 && own(i).every((p) => isLanded(r, p))));
  const items = unstacked.filter((i) => !landed.includes(i));
  // Newest first, as on Treeherder; those waiting for you are the newest anyway.
  const pushes = Object.values(r.pushes).reverse();
  const planned = pushes.filter((p) => isWaiting(r, p));
  const declined = pushes.filter((p) => !p.rev && p.declined !== undefined);
  const rest = pushes.filter((p) => !planned.includes(p) && !declined.includes(p));
  const shownPlans = new Set(r.needsUser.map((n) => recoveryPlanFor(r, n)));
  const plans = r.recoveryPlans.filter((p) => !shownPlans.has(p));
  // A try push's jobs (push, watch) are on its row.
  const running = Object.values(r.jobs).filter((j) => j.item === undefined && j.endedAt === undefined && !(j.purpose?.push !== undefined && j.purpose.push in r.pushes));
  // What you told the factory in the box below is worked on right above it.
  const recovering = running.filter((j) => j.name === "recover");
  const others = running.filter((j) => j.name !== "recover");

  return html`<div class="rbody">
    ${others.length ? html`<div class="jobs">${others.map((j) => jobLine(r, j, ctx))}</div>` : null}
    ${configLine(r)}
    ${pushes.length ? html`<h3>Try pushes${planned.length > 1 ? html` ${approvePushControls(r, planned, back)}` : null}</h3><div class="rows">${[...planned, ...rest].map((p) => pushRowOf(r, p, ctx))}${
      declined.length ? html`<details class="fold" data-fold="declined-pushes"><summary>${declined.length} declined or withdrawn</summary><div class="rows">${declined.map((p) => pushRowOf(r, p, ctx))}</div></details>` : null
    }</div><hr class="part">` : null}
    ${r.metaBug && !(hasBug(r.metaBug) && (stacks.length || landed.length)) ? metaBugLine(r, back, ctx) : null}
    ${stacks.map((s) => stackSection(r, s, ctx))}
    ${loose.length ? html`<h3>Patches</h3><div class="rows">${loose.map((p) => patchRow(r, p, ctx))}</div>` : null}
    ${items.some((i) => itemBucket(r, i, ctx) !== "closed") ? html`${stacks.length || loose.length ? html`<h3>Not in a stack yet</h3>` : null}${groupRows(r, items, ctx, false)}` : null}
    ${landed.length ? html`<h3>Landed${r.metaBug && hasBug(r.metaBug) && !stacks.length ? html` · <a class="bug" href="${bugUrl(r.metaBug.bug)}" target="_blank" rel="noopener">Bug ${r.metaBug.bug}</a> ${metaSummary}` : null}</h3>${groupRows(r, landed, ctx)}` : null}
    ${closedFold(r, items.filter((i) => itemBucket(r, i, ctx) === "closed"), ctx)}
    ${stacks.length || loose.length || items.length || landed.length ? html`<hr class="part">` : null}
    ${requestJobs(r, ctx)}
    ${notesFold(r, plans)}
    ${recoveryAnswers(r, ctx)}
    ${recovering.length ? html`<div class="jobs">${recovering.map((j) => jobLine(r, j, ctx))}</div>` : null}
    <form class="ask cmd reqask" method="post" action="/api/commands">${commandFields([{ cmd: "tell-factory", request: r.id }], back)}<input type="text" name="text" required placeholder="Tell the factory about this request…"><button class="btn">Send</button></form>
  </div>`;
}

// route-request fills every field, most of them often empty.
function configEntries(r: RequestState): [string, string][] {
  return Object.entries(r.config)
    .map(([k, v]): [string, string] => [k, inWords(v)])
    .filter(([, v]) => v !== "");
}

function inWords(v: unknown): string {
  if (Array.isArray(v)) {
    return v.map(inWords).filter(Boolean).join(", ");
  }
  if (v !== null && typeof v === "object") {
    return Object.entries(v)
      .map(([k, x]) => [k, inWords(x)])
      .filter(([, w]) => w)
      .map(([k, w]) => `${k} ${w}`)
      .join(", ");
  }
  if (typeof v === "boolean") {
    return v ? "yes" : "no";
  }
  return v === null || v === undefined ? "" : String(v);
}

// The folder is already in the request's title.
function configLine(r: RequestState): Html | null {
  const entries = configEntries(r).filter(([k, v]) => !(k === "folders" && v === r.folder));
  if (!entries.length) {
    return null;
  }
  return html`<div class="sub" style="margin-top:6px">From your request: ${join(
    entries.map(([k, v]) => html`<b>${k}</b>: ${v}`),
    " · ",
  )}</div>`;
}

function metaBugLine(r: RequestState, back: string, ctx: RenderContext): Html {
  const m = r.metaBug!;
  if (hasBug(m)) {
    return html`<h3 class="stackhead"><span><a class="bug" href="${bugUrl(m.bug)}" target="_blank" rel="noopener">Bug ${m.bug}</a> ${r.metaBug?.draft?.summary ?? "meta bug"}</span></h3>`;
  }
  // Filed last: it depends on the stack's other bugs.
  const unfiled = Object.values(r.stacks).flatMap((s) => stackPatches(r, s)).filter((p) => !isDropped(r, p) && p.bugDraft && !hasBug(p)).length;
  const required = Object.values(r.stacks).some((s) => stackNeedsMetaBug(stackPatches(r, s)));
  const link = !m.draft
    ? null
    : unfiled
      ? html`· <span class="sub">to file once the stack's ${plural(unfiled, "other bug")} ${unfiled === 1 ? "is" : "are"} filed</span>`
      : html`· <a class="bug tofile" href="${metaBugUrl(r, m.draft, ctx)}" target="_blank" rel="noopener">Bug to file</a>`;
  return html`<div class="box"><h4>Meta bug${required ? null : html` <span class="sub">(optional)</span>`} ${link} ${m.draft ? html`· “${m.draft.summary}”` : null}</h4>${
    m.draft ? html`<details data-fold="desc-meta"><summary>Description</summary><div class="desc">${md(m.draft.description)}</div></details>${revisions(r, "meta")}` : null
  }${bugBox(r.id, "meta", back, "row")}</div>`;
}


// The stack's title and stack-viewer link, the meta bug, its patches in review order (easy and valuable first, each
// after its hard deps), then the command to submit them.
function isLanded(r: RequestState, p: PatchView): boolean {
  return p.review?.status === "published" || (p.item !== undefined && r.items[p.item]?.state === "landed");
}

function livePatches(r: RequestState, s: StackView): PatchView[] {
  return stackPatches(r, s).filter((p) => !isLanded(r, p));
}

function stackSection(r: RequestState, s: StackView, ctx: RenderContext): Html {
  const patches = livePatches(r, s);
  const dropped = patches.filter((p) => isDropped(r, p));
  // Once the meta bug is filed, it names the stack.
  const meta = r.metaBug && hasBug(r.metaBug) ? r.metaBug : undefined;
  const title = meta ? html`<a class="bug" href="${bugUrl(meta.bug!)}" target="_blank" rel="noopener">Bug ${meta.bug}</a> ${r.metaBug?.draft?.summary ?? s.folder}` : html`${s.folder}`;
  return html`<h3 class="stackhead"><span title="Branch ${s.branch}; patches in review order: easy and valuable first, each after its hard deps">${title}</span>${stackViewerLink(r, s)}</h3>
    ${optionalMetaBug(r, s, ctx)}
    <div class="rows">${patches.filter((p) => !isDropped(r, p)).map((p) => patchRow(r, p, ctx))}${
      dropped.length ? html`<details class="fold" data-fold="dropped-${s.id}"><summary>${dropped.length} dropped</summary><div class="rows">${dropped.map((p) => patchRow(r, p, ctx))}</div></details>` : null
    }</div>
    <div class="stack-submit">${
      patches.some((p) => p.revision !== undefined) && REQUEST_STEPS.indexOf(r.step) >= REQUEST_STEPS.indexOf("review comments")
        ? pollPhabButton(r.id, requestUrl(r.id))
        : null
    }${submitControls(r, s, requestUrl(r.id))}</div>`;
}

// The bugs of the stacks' patches, which a meta bug tracks.
function stackBugs(r: RequestState): number[] {
  return [...new Set(Object.values(r.stacks).flatMap((s) => stackPatches(r, s)).flatMap((p) => (hasBug(p) ? [p.bug] : [])))];
}

// Outside burndowns, there's no drafted meta bug: when nothing needs one, filing one to track the stack's bugs is up to
// you, and doesn't hold back submitting.
function optionalMetaBug(r: RequestState, s: StackView, ctx: RenderContext): Html | null {
  // A burndown's meta bug is drafted by an agent: shown with the meta bug's box once written.
  if (r.metaBug || r.kind === "burndown") return null;
  const first = stackPatches(r, s).find((p) => p.bugDraft)?.bugDraft;
  const draft: BugDraft = {
    product: first?.product ?? "Testing",
    component: first?.component ?? "General",
    summary: `[meta] Intermittent failures in ${r.folder ?? s.folder}`,
    description: s.summary ?? "",
    bugType: "task",
    keywords: ["meta"],
    dependsOn: stackBugs(r),
  };
  const lead = stackNeedsMetaBug(stackPatches(r, s)) ? "This stack needs a meta bug, for its annotation patches" : "A meta bug is optional here";
  return html`<div class="metabug sub">${lead}: <a href="${enterBugUrl(draft, ctx)}" target="_blank" rel="noopener" title="Opens a prefilled enter_bug.cgi, depending on the stack's bugs">file one ↗</a> to track the stack's bugs, then paste its number ${bugBox(r.id, "meta", requestUrl(r.id))}</div>`;
}

// One line per group or patch: its name and cost, then where it stands. Opening it shows the rest
// under it, its jobs open on what their agent did.
interface Row {
  anchor: Html; // its id and data- attributes
  fold: string;
  cls: StateClass;
  name: Html;
  title: string;
  end: Html | null;
  state: Html;
  trust?: Html | null; // the evidence and reproduction behind it
  warn?: Html | null; // what you should know before answering, under its state
  ask?: Html; // what a group needing you asks, with its buttons: in sight without opening the row
  under?: Html | null; // opened, right under its name: a patch's bug to file
  body: Html;
}

// Opened, the box under its name comes first in the body (clicking in it mustn't fold the row), styled as hanging
// from its label; its state and trust lines then move under the box.
function row(x: Row): Html {
  const lines = html`<span class="state">${x.state}</span>${x.trust ? html`<span class="trust">${x.trust}</span>` : null}`;
  const d = html`<details class="row" ${x.anchor} data-fold="${x.fold}"><summary><span class="st ${x.cls}"></span><span class="name" title="${x.title}">${x.name}</span><span class="end">${x.end}</span>${lines}${
    x.warn ? html`<span class="warn">${x.warn}</span>` : null
  }</summary>${x.under ? html`<div class="under">${x.under}<div class="lines">${lines}</div></div>` : null}<div class="rowbody">${x.body}</div></details>`;
  return x.ask ? html`<div class="asks">${d}<div class="ask-you">${x.ask}</div></div>` : d;
}

// The question, the patch to look at, then the answers; then the group's other ⚑s, each with its own answers.
// withFirst: false when the first ⚑'s answers are elsewhere on the row (the bug box).
function askBlock(r: RequestState, i: ItemView, ctx: RenderContext, patches: PatchView[], withFirst = true): Html | undefined {
  const s = itemSentence(r, i, ctx);
  if (s.cls !== "find" || !s.ask) {
    return undefined;
  }
  const more = r.needsUser.filter((n) => flagItemOf(r, n) === i.id).slice(1);
  if (!withFirst && !more.length) {
    return undefined;
  }
  const controls = (c: Html | null) => (c ? html`<div class="jobctl">${c}</div>` : null);
  return html`${withFirst ? html`${s.ask}${patches.length ? html`<p>${patches.map((p) => html`“${patchTitle(p)}” ${viewLink(r, p, "View the patch")} `)}</p>` : null}${controls(s.controls)}` : null}${more.map(
    (n) => html`<div class="ask-more" data-key="${n.key}"><p><b>Also: ${flagText(r, n)}</b></p>${flagAsk(r, i, n)}${controls(flagControls(r, n, ctx))}</div>`,
  )}`;
}

// What needs you first, then what runs, what's ready and what waits; the closed ones folded under one line.
const ORDER: Bucket[] = ["needs you", "working", "ready", "pending", "landed"];

function groupRows(r: RequestState, items: ItemView[], ctx: RenderContext, withClosed = true): Html {
  const bucket = new Map(items.map((i) => [i.id, itemBucket(r, i, ctx)]));
  return html`<div class="rows">${ORDER.flatMap((b) => items.filter((i) => bucket.get(i.id) === b)).map((i) => itemRows(r, i, ctx))}${
    withClosed ? closedFold(r, items.filter((i) => bucket.get(i.id) === "closed"), ctx) : null
  }</div>`;
}

function closedFold(r: RequestState, closed: ItemView[], ctx: RenderContext): Html | null {
  return closed.length ? html`<details class="fold" data-fold="closed-groups"><summary>${closed.length} closed</summary><div class="rows">${closed.map((i) => itemRows(r, i, ctx))}</div></details>` : null;
}

// Once a group has a reviewed patch, the patch's row replaces the group's.
function itemRows(r: RequestState, i: ItemView, ctx: RenderContext): Html {
  // A commit its author squashed away stays a patch of the group, outside every stack, while a sibling is in one.
  const stacked = new Set(Object.values(r.stacks).flatMap((s) => s.order));
  const own = Object.values(r.patches).filter((p) => p.item === i.id && !isDraft(r, p) && !isDropped(r, p));
  const live = own.some((p) => stacked.has(p.id)) ? own.filter((p) => stacked.has(p.id)) : own;
  return live.length ? html`${live.map((p) => patchRow(r, p, ctx))}` : groupRow(r, i, ctx);
}

function itemCost(r: RequestState, i: ItemView): number {
  return i.jobs.reduce((sum, j) => sum + (r.jobs[j].costUsd ?? 0), 0);
}

function costLabel(usd: number): Html | null {
  return usd > 0 ? html`<span class="cost" title="Agent cost of this group so far">${formatCost(usd)}</span>` : null;
}

function stateText(r: RequestState, i: ItemView, ctx: RenderContext): Html {
  const s = itemSentence(r, i, ctx);
  return html`${s.text}${s.detail ? `: ${s.detail}` : null}`;
}

// A ready group or patch gets the ✓, even while it waits for the rest of its stack.
function rowClass(r: RequestState, i: ItemView, ctx: RenderContext): StateClass {
  return itemBucket(r, i, ctx) === "ready" ? "ok" : itemSentence(r, i, ctx).cls;
}

function groupRow(r: RequestState, i: ItemView, ctx: RenderContext): Html {
  const sentence = itemSentence(r, i, ctx);
  const patches = Object.values(r.patches).filter((p) => p.item === i.id);
  // Its author can't be resumed once its worktree was removed to free the disk.
  const removed = Object.values(r.jobs).some((j) => j.item === i.id && j.name === "worktree.ts remove" && j.exitCode === 0);
  const reopen = stateClass(i.state) === "closed" && hasAuthorSession(r, i.id) && !removed && !r.needsUser.some((n) => n.item === i.id);
  return row({
    anchor: html`id="item-${i.id}" data-item="${i.id}"`,
    fold: `item-${i.id}`,
    cls: rowClass(r, i, ctx),
    name: html`${groupLabel(r, i)}`,
    title: [...i.group.tests, i.group.configs.join(", ")].join("\n"),
    // Redo is on the top line: the group's patches are in its folded body, and it's what you'd want of it.
    end: i.id === ANNOTATIONS_ITEM && !Object.values(r.jobs).some((j) => j.item === i.id && j.endedAt === undefined)
      ? html`${redoAnnotationsButton(r.id, requestUrl(r.id))} ${costLabel(itemCost(r, i))}`
      : costLabel(itemCost(r, i)),
    state: stateText(r, i, ctx),
    trust: trustLine(r, i, ctx),
    ask: askBlock(r, i, ctx, patches.filter((p) => isDraft(r, p))),
    body: html`${failure(r, i)}${investigationHtml(i) ? html`<h4 class="part">The fix</h4>${investigationHtml(i)}` : null}${debugCommitsHtml(r, i)}${talkBox(r, i, ctx)}${sentence.ask ? null : sentence.controls ? html`<div class="jobctl">${sentence.controls}</div>` : null}${patches
      .filter((p) => isDraft(r, p))
      .map((p) => html`<div>Draft patch, its critical review hasn't passed yet: “${patchTitle(p)}” ${viewLink(r, p)}</div>`)}${patches
      .filter((p) => isDropped(r, p))
      .map((p) => html`<div>Dropped patch: “${patchTitle(p)}” ${viewLink(r, p)}</div>`)}${
      reopen ? html`<details class="reopen" data-fold="reopen-${i.id}"><summary class="btn small">Reopen…</summary>${continueBox(r.id, i.id, requestUrl(r.id))}</details>` : null
    }${itemJobs(r, i, ctx)}`,
  });
}

// Whatever its state, you can tell its author what to change, or close it; a group asking you has these in its
// question, a closed one Reopen.
function talkBox(r: RequestState, i: ItemView, ctx: RenderContext): Html | null {
  const s = itemSentence(r, i, ctx);
  if (s.ask || s.cls === "run" || ["fixed", "landed", "left as-is", "handed back"].includes(i.state)) {
    return null;
  }
  return html`<div class="jobctl">${hasAuthorSession(r, i.id) ? continueBox(r.id, i.id, requestUrl(r.id)) : null}${handBackButton(r.id, i.id, requestUrl(r.id))}</div>`;
}

// Agents can't push to try; you can let its author make one push (it may be running).
// The failure a group is about: its message, its tests when there are several, and where it failed, laid out like
// tests.firefox.dev's pass/fail table (its rates are a click away).
function failure(r: RequestState, i: ItemView, prefix = "The failure"): Html {
  const g = i.group;
  const tests = g.tests.length > 1 ? g.tests.map((t) => (r.folder && t.startsWith(`${r.folder}/`) ? t.slice(r.folder.length + 1) : t)).join(", ") : null;
  const dashboard = /\.(toml|ini)$/.test(g.tests[0]) ? null : html` · <a href="https://tests.firefox.dev/test.html?test=${encodeURIComponent(g.tests[0])}" target="_blank" rel="noopener">rates on tests.firefox.dev ↗</a>`;
  const rate = g.ratePerWeek === undefined ? null : html` · ${g.ratePerWeek} failures/week`;
  return html`<h4 class="part">${prefix}</h4><div class="failure">${g.message}</div>${tests ? html`<div class="sub">${tests}</div>` : null}${
    g.configs.length ? html`${configTable(g.configs)}<div class="sub">${plural(g.configs.length, "config")}${rate}${dashboard}</div>` : null
  }`;
}

const OSES: [RegExp, string][] = [[/^linux/, "Linux"], [/^macosx/, "macOS"], [/^windows/, "Windows"], [/^android/, "Android"]];
const BUILDS = ["opt", "debug", "asan", "tsan", "ccov"];

// test-linux2404-64-shippable/opt-mochitest-browser-chrome-swr → Linux, opt, browser-chrome-swr.
export function parseConfig(config: string): { os: string; build: string; suite: string } | undefined {
  const m = /^(?:test-)?([^/]+)\/([a-z]+)-(.+)$/.exec(config);
  const os = m && OSES.find(([re]) => re.test(m[1]))?.[1];
  if (!m || !os) return undefined;
  const variant = /-(asan|tsan|ccov)(?:-|$)/.exec(m[1])?.[1];
  // Chunks are one job, as on tests.firefox.dev.
  return { os, build: variant ?? m[2], suite: m[3].replace(/^mochitest-/, "").replace(/-\d+$/, "") };
}

export function configTable(configs: string[]): Html {
  const parsed = configs.map((c) => ({ c, p: parseConfig(c) }));
  const known = parsed.filter((x) => x.p);
  const oses = OSES.map(([, os]) => os).filter((os) => known.some((x) => x.p!.os === os));
  const rows = [...new Set(known.map((x) => `${x.p!.build} ${x.p!.suite}`))].sort((a, b) => {
    const [ba, sa] = a.split(" ");
    const [bb, sb] = b.split(" ");
    return (BUILDS.indexOf(ba) + 1 || 99) - (BUILDS.indexOf(bb) + 1 || 99) || sa.localeCompare(sb);
  });
  const others = parsed.filter((x) => !x.p).map((x) => x.c);
  return html`${rows.length ? html`<table class="ptable"><thead><tr><th>Job</th>${oses.map((os) => html`<th>${os}</th>`)}</tr></thead><tbody>${rows.map((row) => {
    return html`<tr><td class="mono">${row}</td>${oses.map((os) => {
      const here = known.filter((x) => x.p!.os === os && `${x.p!.build} ${x.p!.suite}` === row).map((x) => x.c);
      return here.length ? html`<td><span class="failbadge" title="${here.join("\n")}">FAIL</span></td>` : html`<td class="none">—</td>`;
    })}</tr>`;
  })}</tbody></table>` : null}${others.length ? html`<div class="sub">${others.join(", ")}</div>` : null}`;
}

function patchRow(r: RequestState, p: PatchView, ctx: RenderContext): Html {
  const back = requestUrl(r.id);
  const item = itemOf(r, p);
  const sentence = item ? itemSentence(r, item, ctx) : undefined;
  const landable = isLandable(r, p);
  const bugBoxShown = !hasBug(p) && p.bugDraft !== undefined;
  // A "file the bug" ⚑'s buttons are the bug box's.
  const controls = bugBoxShown && r.needsUser.some((n) => n.patch === p.id && actionKind(n, r) === "file-bug") ? null : sentence?.controls;
  // A group's question is asked once, on the row of its first patch.
  const asks = item !== undefined && Object.values(r.patches).find((x) => x.item === item.id && !isDraft(r, x) && !isDropped(r, x)) === p;
  return row({
    anchor: html`id="patch-${p.id}" data-patch="${p.id}"`,
    fold: `patch-${p.id}`,
    cls: item ? rowClass(r, item, ctx) : landable ? "ok" : "wait",
    name: html`${p.revision ? html`<a class="phab" href="${phabUrl(p.revision)}" title="D${p.revision}" target="_blank" rel="noopener">${PHAB_ICON}</a>` : null}${bugLabel(p, ctx)} ${patchTitle(p)}`,
    title: p.title,
    end: html`${viewLink(r, p)}${item ? costLabel(itemCost(r, item)) : null}`,
    // "in the stack" says nothing a patch row in its stack's section doesn't.
    state: html`${item ? html`fixes <b>${groupLinks(r, item)}</b>${item.state === "in stack" ? null : html` · ${stateText(r, item, ctx)}`}` : p.review ? p.review.status : null}${landable ? html` · <span class="landable">landable</span>` : null}`,
    trust: item ? trustLine(r, item, ctx) : null,
    ask: item && asks ? askBlock(r, item, ctx, [], controls !== null) : undefined,
    under: bugBoxShown ? bugDraftBox(r, p, back) : null,
    body: html`${testPlanSection(r, p, back)}${item ? failure(r, item) : null}<h4 class="part">The fix</h4>${item ? investigationHtml(item) : null}${p.effort === undefined ? null : html`<div class="sub">review effort ${p.effort}/5</div>`}${reviewers(p)}${p.deps.map((d) => depLine(r, d))}${controls && !sentence?.ask ? html`<div class="jobctl">${controls}</div>` : null}${reviewBox(r, p, back, p.interdiffFile === undefined ? undefined : ctx.interdiff?.(p))}${
      item ? html`<h4 class="part">What the factory did</h4>${talkBox(r, item, ctx)}${itemJobs(r, item, ctx)}` : null
    }`,
  });
}

// Its test plan for reviewers, as Phabricator will show it: copied, set on its revision with a click (the factory's
// one write to Phabricator), or revised by the agent that wrote it.
function testPlanSection(r: RequestState, p: PatchView, back: string): Html | null {
  const text = p.testPlan ?? p.testPlanSent?.text;
  if (text === undefined) {
    return null;
  }
  const sent = p.testPlanSent;
  const id = `test-plan-${p.id}`;
  const status = sent ? html`<span class="sub">on D${sent.revision} since ${formatDate(sent.t)}${sent.text !== text ? ", not this version" : ""}</span>` : null;
  const set =
    p.revision === undefined || sent?.text === text
      ? null
      : html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "set-test-plan", request: r.id, patch: p.id, text }], back)}<button class="btn small primary">${sent ? `Update D${p.revision}'s test plan` : `Set as D${p.revision}'s test plan`}</button></form>`;
  return html`<h4 class="part">Test plan</h4><div class="testplan">${md(text, itemOf(r, p)?.group.tests)}</div><div class="row testplanctl"><textarea hidden id="${id}">${text}</textarea><button type="button" class="btn small" data-copy="${id}">Copy</button>${set}${status}</div>${
    p.testPlan === undefined
      ? null
      : html`<form class="cmd revise" method="post" action="/api/commands">${commandFields([{ cmd: "revise-test-plan", request: r.id, patch: p.id }], back)}<textarea name="text" required rows="2" placeholder="What should change? The agent that wrote it gets this"></textarea><button class="btn small">Revise</button></form>`
  }`;
}

// The bug its commit message starts with; the link of one to file opens Bugzilla's form prefilled with its draft.
function bugLabel(p: PatchView, ctx: RenderContext): Html | null {
  if (hasBug(p)) {
    return html`<a class="bug" href="${bugUrl(p.bug)}" target="_blank" rel="noopener">Bug ${p.bug}</a>`;
  }
  if (p.bugDraft) {
    return html`<a class="bug tofile" href="${enterBugUrl(p.bugDraft, ctx)}" target="_blank" rel="noopener" title="Opens a prefilled enter_bug.cgi; paste its number below">Bug to file</a>`;
  }
  return p.item === ANNOTATIONS_ITEM ? html`<span class="bug none" title="Goes under the meta bug">meta bug</span>` : html`<span class="bug missing" title="Its author gives it one: an open bug for this failure, or a draft to file">no bug yet</span>`;
}

// A recovery plan already answered: what you said, then what it planned, couldn't do and asked.
function pastPlan(r: RequestState, p: RequestState["recoveryPlans"][number]): Html {
  return html`<details class="note" data-fold="plan-${p.t}"><summary><b>You said: “${p.text.split("\n")[0]}”</b> <span class="sub">${formatDate(p.t)}</span></summary>${p.answer ? md(p.answer) : null}<ul>${p.plan.map(
    (c) => html`<li>${plannedLabel(c, r)}<div class="sub">${c.reason}</div></li>`,
  )}${p.cannotDo.map((t) => html`<li>Can't do: ${t}</li>`)}${p.questions.map((t) => html`<li>Asked you: ${t}</li>`)}</ul></details>`;
}

// A note's subject on one line in bold, the rest when opened, one point per line.
// The factory's notes and the recovery plans already answered are all notes, oldest first.
function notesFold(r: RequestState, plans: RequestState["recoveryPlans"]): Html | null {
  const notes = [...r.notes.slice(-10).map((n) => ({ t: n.t, h: noteHtml(n) })), ...plans.map((p) => ({ t: p.t, h: pastPlan(r, p) }))].sort((a, b) => a.t.localeCompare(b.t));
  return notes.length ? html`<details class="fold" data-fold="notes"><summary>${plural(notes.length, "note")}</summary><div class="notes">${notes.map((n) => n.h)}</div></details>` : null;
}

function noteHtml(n: RequestState["notes"][number]): Html {
  const colon = n.text.indexOf(": ");
  const [title, body] = colon > 0 && colon < 80 ? [n.text.slice(0, colon), n.text.slice(colon + 2)] : [n.text, ""];
  const items = body.split("\n");
  const fold = `note-${n.t}`;
  return body
    ? html`<details class="note" data-fold="${fold}"><summary><b>${title}</b> <span class="sub">${formatDate(n.t)}${items.length > 1 ? ` · ${items.length} points` : ""}</span></summary>${
        items.length > 1 ? html`<ul>${items.map((x) => html`<li>${x}</li>`)}</ul>` : html`<p>${body}</p>`
      }</details>`
    : html`<div class="note"><b>${title}</b> <span class="sub">${formatDate(n.t)}</span></div>`;
}

// How we know, on one line: the kinds of evidence and whether the failure was reproduced, each label a link to
// the file its author wrote about it. A cause read off the code alone, or a failure nobody reproduced, is flagged.
function trustLine(r: RequestState, i: ItemView, ctx: RenderContext): Html | null {
  const inv = i.investigation;
  if (!inv) {
    return null;
  }
  // Reports from before evidence and reproduction were asked for: its author can still say.
  const ask = (!inv.files || !inv.reproduction) && itemBucket(r, i, ctx) !== "working" && hasAuthorSession(r, i.id) ? askEvidence(r, i) : null;
  const sources = [...new Set((inv.evidence ?? []).map((e) => e.source))];
  const evidence = !inv.evidence
    ? html`<span class="weak">Evidence not reported</span>`
    : html`${fileLink(r, i, "evidence", "Evidence")}: ${sources.every((x) => x === "code reading") ? html`<span class="weak">code reading only</span>` : sources.join(", ")}`;
  const rp = inv.reproduction;
  const repro = !rp
    ? html`<span class="weak">Reproduction not reported</span>`
    : !rp.reproduced
      ? html`<span class="bad">${fileLink(r, i, "reproduction", "Not reproduced")}</span>`
      : html`${fileLink(r, i, "reproduction", `Reproduced ${rp.where ?? ""}`.trim())}${rp.widened ? html`, ${fileLink(r, i, "widening", "race widened")}` : null}: <span class="rates" title="${rp.before}${rp.after ? ` → with the fix ${rp.after}` : ""}">${rp.before}${rp.after ? ` → ${rp.after}` : ""}</span>`;
  return html`${evidence} · ${repro}${ask}`;
}

// The file its author wrote about it, rendered in a new tab; the label alone when there is none.
function fileLink(r: RequestState, i: ItemView, which: "evidence" | "reproduction" | "widening", label: string): Html {
  const file = i.investigation?.files?.[which];
  return file ? html`<a href="/requests/${encodeURIComponent(r.id)}/items/${encodeURIComponent(i.id)}/files/${which}" target="_blank" rel="noopener" title="${file}">${label}</a>` : html`${label}`;
}

// What goes to try on top of the stack for a group that needs CI evidence: you see it before approving that push.
function debugCommitsHtml(r: RequestState, i: ItemView): Html | null {
  const commits = i.state === "waiting for a try repro" ? (i.lastReport?.report as { commits?: string[] } | undefined)?.commits : undefined;
  if (!commits?.length) {
    return null;
  }
  return html`<p class="sub">Its DEBUG ${commits.length === 1 ? "commit" : "commits"} (${commits.map((c) => c.slice(0, 12)).join(", ")}) go to try on top of the stack's next push. <a href="/requests/${encodeURIComponent(r.id)}/items/${encodeURIComponent(i.id)}/debug" target="_blank">View ↗</a></p>`;
}

function investigationHtml(i: ItemView): Html | null {
  const inv = i.investigation;
  if (!inv?.cause) {
    return null;
  }
  return html`<div class="why">${md(`Cause: ${inv.cause}`, i.group.tests)}${inv.verification ? html`<details class="fold" data-fold="verified-${i.id}"><summary>How it was verified</summary>${md(inv.verification, i.group.tests)}</details>` : null}</div>`;
}

const ASK_EVIDENCE =
  "Before this goes further, show how you know. Write artifacts/evidence.md: what shows the cause (profiles, logs, local runs, or only reading the code), and why the fix belongs where it is. Write artifacts/reproduction.md: how you reproduced the failure before your fix, locally (or, for a platform you don't have, in the factory's un-skip try push: never push to try yourself), and how often it failed without and with the fix; save a patch that widens the race as artifacts/reproduction.diff. If you never reproduced it, do it now; if you can't, report the state \"not reproduced\". Don't change the fix unless reproducing it shows it is wrong.";

function askEvidence(r: RequestState, i: ItemView): Html {
  return html` <form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "continue", request: r.id, item: i.id }], requestUrl(r.id))}<input type="hidden" name="text" value="${ASK_EVIDENCE}"><button class="btn small" title="Resumes its author with: ${ASK_EVIDENCE}">Ask its author</button></form>`;
}

// The agents of a group, newest first, with what runs or failed; the scripts that went fine aren't worth a line.
function itemJobs(r: RequestState, i: ItemView, ctx: RenderContext): Html | null {
  const jobs = i.jobs
    .map((j) => r.jobs[j])
    .filter((j) => j.kind === "agent" || j.endedAt === undefined || j.exitCode !== 0)
    .reverse();
  return groupJobs(r, i, jobs, ctx);
}

// The request's own jobs (route-request, recover, plan-try-pushes, try watch…), the running ones at the top of the body.
function requestJobs(r: RequestState, ctx: RenderContext): Html | null {
  const jobs = Object.values(r.jobs)
    .filter((j) => j.item === undefined && j.endedAt !== undefined)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return jobs.length ? html`<details class="fold" data-fold="jobs"><summary>${plural(jobs.length, "task")}</summary><div class="jobs">${jobs.map((j) => jobLine(r, j, ctx))}</div></details>` : null;
}

function bugDraftBox(r: RequestState, p: PatchView, back: string): Html {
  const d = p.bugDraft!;
  return html`<div class="box tofile">
    <h4>${d.product}::${d.component} · “${d.summary}”</h4>
    <details data-fold="desc-${p.id}"><summary>Description</summary><div class="desc">${md(d.description)}</div></details>
    ${revisions(r, p.id)}${bugBox(r.id, p.id, back, "row")}
  </div>`;
}

// What your comments on a bug draft did: the draft above is the latest revision. Jobs from before 2026-10-19 don't
// have the comment.
function revisions(r: RequestState, patch: string): Html | null {
  const jobs = Object.values(r.jobs).filter((j) => j.purpose?.what === "revise-draft" && j.purpose.patch === patch);
  return jobs.length
    ? html`<div class="revisions">${jobs.map(
        (j) =>
          html`<div class="sub">${j.endedAt === undefined ? "Revising it after" : j.exitCode === 0 ? "Revised after" : "Couldn't revise it after"} your comment${j.purpose!.reason === undefined ? null : html` “${j.purpose!.reason}”`} · ${formatDate(j.startedAt)}${
            j.outcome ? html`<div class="answer">It answered: ${j.outcome}</div>` : null
          }</div>`,
      )}</div>`
    : null;
}

function depLine(r: RequestState, d: PatchView["deps"][number]): Html {
  const needed = r.patches[d.needs];
  const label = needed ? `“${patchTitle(needed)}”${needed.revision ? ` (D${needed.revision})` : ""}` : d.needs;
  const met = needed !== undefined && itemOf(r, needed)?.state === "landed";
  return html`<div class="dep${met ? " met" : ""}">${d.kind === "hard" ? "⛔ hard" : "🔗 soft"}: needs ${label} (${d.reason})</div>`;
}

function reviewers(p: PatchView): Html | null {
  if (!p.review) {
    return null;
  }
  const cls = { accepted: "ok", blocking: "block", pending: "pend", resigned: "pend" } as const;
  return html`<div>${p.review.reviewers.map((x) => html`<span class="rv ${cls[x.status]}"${x.status === "resigned" ? html` title="resigned"` : null}>${x.name}</span>`)}<span class="sub">${p.review.status}</span></div>`;
}

// Interdiff, the comments still to answer, and the drafted replies to post.
function reviewBox(r: RequestState, p: PatchView, back: string, interdiff: string | undefined): Html | null {
  const comments = p.review?.comments ?? [];
  const drafts = new Map(p.replyDrafts.map((d) => [d.commentId, d.text]));
  const shown = comments.filter((c) => !c.done || drafts.has(c.id));
  if (p.interdiffFile === undefined && !shown.length) {
    return null;
  }
  const revision = p.review?.revision ?? p.revision;
  return html`<div class="box">
    ${p.interdiffFile === undefined ? null : html`<h4>Interdiff</h4>${interdiff === undefined ? html`<div class="sub">${p.interdiffFile} can't be read</div>` : diff(interdiff)}`}
    ${shown.map((c) => {
      const draft = drafts.get(c.id);
      return html`<div class="comment" data-comment="${c.id}"><b>${c.author}</b>${c.file ? html` <span class="sub mono">${c.file}${c.line ? `:${c.line}` : ""}</span>` : null}${c.kind ? html` <span class="sub">(${c.kind})</span>` : null}: ${c.text}${
        c.suggestion ? html`<pre class="diff">${c.suggestion}</pre>` : null
      }</div>${
        draft !== undefined
          ? html`<h4>Draft reply</h4><textarea rows="${Math.min(6, draft.split("\n").length)}" id="reply-${p.id}-${c.id}">${draft}</textarea>
            <div class="row">${copyButton(`reply-${p.id}-${c.id}`, "Copy reply", true)}${
              revision ? html`<a class="btn small" href="${phabUrl(revision, c.id)}" target="_blank" rel="noopener" title="D${revision}#inline-${c.id}">Open comment ↗</a>` : null
            }</div>`
          : null
      }`;
    })}
    <form class="row cmd" method="post" action="/api/commands">${commandFields([{ cmd: "comment-fix", request: r.id, patch: p.id }], back)}<input type="text" name="text" required placeholder="Comment on the fix…"><button class="btn small">Send</button></form>
  </div>`;
}

export function diff(text: string): Html {
  return html`<pre class="diff">${text.split("\n").map((line, i) => {
    const nl = i === 0 ? "" : "\n";
    if (line.startsWith("@@")) {
      return html`${nl}<span class="h">${line}</span>`;
    }
    if (line.startsWith("+")) {
      return html`${nl}<span class="a">${line}</span>`;
    }
    if (line.startsWith("-")) {
      return html`${nl}<span class="r">${line}</span>`;
    }
    return html`${nl}${line}`;
  })}</pre>`;
}


// The patch in stack-viewer, where comments go back to its author.
function viewLink(r: RequestState, p: PatchView, label = "view"): Html {
  return html`<a href="/requests/${encodeURIComponent(r.id)}/patches/${encodeURIComponent(p.id)}/view" target="_blank" rel="noopener" title="Opens the patch in stack-viewer; your comments there go to its author">${label}</a>`;
}

// One row per try push: its purpose, tasks and, while it waits for you, Approve and Decline; then where it
// stands. Opened, its whole purpose, its jobs laid out like Treeherder, its command and try_task_config, and the box
// to say why not.
function pushRowOf(r: RequestState, p: PushView, ctx: RenderContext): Html {
  const tasks = `/api/requests/${encodeURIComponent(r.id)}/pushes/${encodeURIComponent(p.id)}/tasks`;
  const waiting = isWaiting(r, p);
  const job = Object.values(r.jobs).findLast((j) => j.purpose?.push === p.id && j.purpose.what === "push");
  return row({
    anchor: html`id="push-${p.id}" data-push="${p.id}"${p.taskCount === undefined ? null : html` data-tasks="${tasks}"`}`,
    fold: `push-${p.id}`,
    cls: p.rev ? ({ ok: "ok", bad: "find", run: "run" } as const)[pushResultClass(p)] : waiting || (job && job.exitCode !== 0 && job.endedAt) ? "find" : p.declined === undefined ? "run" : "closed",
    name: html`push ${pushName(r, p.id)}: ${p.purpose}`,
    title: p.purpose,
    end: html`${p.taskCount === undefined ? null : html`<span>${plural(p.taskCount, "task")}</span><a class="btn small" href="/requests/${encodeURIComponent(r.id)}/pushes/${encodeURIComponent(p.id)}/view" target="_blank" rel="noopener" title="The commits it carries, in stack-viewer">View stack ↗</a>`}${
      p.rev ? html`<a class="mono" href="${pushUrl(p)}" target="_blank" rel="noopener">${p.rev.slice(0, 12)}</a>` : null
    }${waiting ? html`${approvePushControls(r, [p], requestUrl(r.id))}${discardButton(r, p)}` : null}${
      revisable(r, p) ? html`<button type="button" class="btn small" data-revise title="Tell the agent that planned it what to change">Revise…</button>` : null
    }`,
    state: html`${
      p.rev
        ? pushOutcome(r, p)
        : p.declined !== undefined
          ? p.withdrawn
            ? html`withdrawn by the factory: ${p.declined}`
            : p.replan
              ? html`you asked for a revision: ${p.declined}`
              : p.declined === DISCARDED
                ? "you discarded it"
                : html`you declined it: ${p.declined}`
          : waiting
            ? "waiting for your approval"
            : !job
              ? "approved"
              : job.endedAt === undefined
                ? html`approved, pushing for ${elapsed(job.startedAt, ctx)}`
                : job.exitCode === 0
                  ? "pushed, waiting for its revision"
                  : "approved, not pushed: see its ⚑ above"
    }`,
    warn: waiting ? dryRunWarnings(r, p) : null,
    // While it waits for you, what it would run; once made, what came of it, its jobs and command folded under it.
    body: html`${sinceSection(r, p, ctx)}${waiting ? null : pushAnalysis(r, p)}${
      waiting ? pushJobs(p) : html`<details class="fold" data-fold="pushjobs-${p.id}"><summary>Its jobs, commits and command</summary>${pushJobs(p)}</details>`
    }${revisable(r, p) ? reviseBox(r, p) : null}`,
  });
}

// What it's judged by: what changed in the stack since its previous push (each changed patch's interdiff and what its
// author said it fixes), and that push's regressions with the patch that claims to fix each.
function sinceSection(r: RequestState, p: PushView, ctx: RenderContext): Html | null {
  // A push planned before the planner knew of the changes still shows them while it waits for you.
  const stack = Object.values(r.jobs).find((j) => j.purpose?.what === "dry-run" && j.purpose.push === p.id)?.purpose?.stack;
  const latest = stack === undefined ? undefined : r.pushChanges[stack];
  const since = p.since ?? (isWaiting(r, p) && latest?.since !== p.id ? latest?.since : undefined);
  if (since === undefined) {
    return null;
  }
  const prev = r.pushes[since];
  const changes = Object.values(r.pushChanges).find((c) => c.since === since);
  const title = (id: string) => (r.patches[id] ? patchTitle(r.patches[id]) : id);
  const regressions = p.regressions?.length
    ? html`<h4 class="part">The regressions of push ${pushName(r, since)}</h4><ul class="regressions">${p.regressions.map(
        (g) => html`<li>${md(g.failure)}<div class="sub">${g.fixedBy ? html`fixed by <a href="#patch-${g.fixedBy}">${title(g.fixedBy)}</a>: ` : html`<b>not fixed yet</b>: `}${g.how}</div></li>`,
      )}</ul>`
    : null;
  const changed = changes?.changes.filter((c) => c.status !== "same") ?? [];
  const list = changes
    ? html`<h4 class="part">Changed since push ${pushName(r, since)}${prev?.rev ? html` (<a href="${pushUrl(prev)}" target="_blank" rel="noopener">${prev.summary ?? prev.result}</a>)` : null}</h4>${
        changed.length === 0 && changes.removed.length === 0
          ? html`<div class="sub">Nothing: the same patches.</div>`
          : html`<ul class="changes">${changed.map((c) => {
              const text = c.interdiffFile ? ctx.readData?.(c.interdiffFile) : undefined;
              const said = authorSaid(r, c.patch);
              return html`<li><b>${c.status === "new" ? "new" : "changed"}</b>: <a href="#patch-${c.patch}">${title(c.patch)}</a>${said ? html`<div class="sub clamp1" title="${said}">${said}</div>` : null}${
                text === undefined ? null : html`<details class="fold" data-fold="since-${p.id}-${c.patch}"><summary>Interdiff</summary>${diff(text)}</details>`
              }</li>`;
            })}${changes.removed.map((x) => html`<li><b>gone</b>: ${x.title}</li>`)}</ul>`
      }`
    : null;
  return html`${regressions}${list}`;
}

// What the latest run of a patch's author said it did.
function authorSaid(r: RequestState, patch: string): string | undefined {
  const item = r.patches[patch]?.item;
  return item === undefined ? undefined : (r.items[item]?.lastReport?.report as { summary?: string } | undefined)?.summary;
}

// Planned, and its approval is still asked.
function isWaiting(r: RequestState, p: PushView): boolean {
  return !p.rev && p.declined === undefined && r.needsUser.some((n) => n.key === `approve-push:${p.id}`);
}

// The dry run's warnings, which its approval ⚑ carries after "N tasks · purpose" (see handlers.ts, "dry-run").
function dryRunWarnings(r: RequestState, p: PushView): Html | null {
  let rest = r.needsUser.find((n) => n.key === `approve-push:${p.id}`)!.detail;
  for (const known of [`${p.taskCount} tasks`, p.purpose]) {
    if (rest === known) {
      return null;
    }
    if (!rest.startsWith(`${known} · `)) {
      // Not written by the dry run: nothing to tell apart.
      return known === p.purpose ? html`⚠ ${rest}` : null;
    }
    rest = rest.slice(known.length + 3);
  }
  return html`⚠ ${rest}`;
}

function pushJobs(p: PushView): Html {
  return p.taskCount === undefined ? html`<pre class="mono command">${p.command.join(" ")}</pre>` : html`<div class="ptasks">Loading…</div>`;
}

// The authors its failures were sent to (those in tests their patches change or fix).
function routedTo(r: RequestState, p: PushView): ItemView[] {
  const ids = Object.values(r.jobs).filter((j) => j.purpose?.reason === "try" && new RegExp(`:try:${p.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(:final)?$`).test(j.purpose.key)).map((j) => j.item);
  return [...new Set(ids)].flatMap((id) => (id && r.items[id] ? [r.items[id]] : []));
}

// A push an author asked for (…-ask-<hash>): its results go back to that author, whose answer says what came of them.
function askedBy(r: RequestState, p: PushView): { item: ItemView; job?: JobView } | undefined {
  const prefix = /^(.*)-ask-[0-9a-f]{4}(-\d+)?$/.exec(p.id)?.[1];
  const item = prefix === undefined ? undefined : Object.values(r.items).find((i) => i.id.replace(/^i-/, "").slice(0, 24) === prefix);
  if (!item) return undefined;
  return { item, job: Object.values(r.jobs).findLast((j) => j.item === item.id && j.purpose?.reason === "asked push") };
}

// One line: how many jobs failed, and what the factory made of them.
function pushOutcome(r: RequestState, p: PushView): Html {
  const status = pushStatus(p);
  if (p.result !== "failures" && !p.progress?.failures) {
    return html`${status}`;
  }
  // "32 jobs, 5 failed (3 retried): <every job>…" → its count; the jobs are under it.
  const count = status.split(":")[0];
  const verdicts = new Map<string, number>();
  for (const c of p.analysis ?? []) verdicts.set(c.verdict, (verdicts.get(c.verdict) ?? 0) + 1);
  const authors = routedTo(r, p);
  const asker = askedBy(r, p);
  if (asker) {
    const answer = asker.job?.outcome;
    return html`${count} · ${asker.job ? (asker.job.endedAt ? html`its author: ${answer ?? "done"}` : "its author is reading the results") : "results go to its author"}`;
  }
  const made = [
    ...[...verdicts].map(([v, n]) => `${n} ${v}`),
    ...(authors.length ? [`sent to the author${authors.length > 1 ? "s" : ""} of ${authors.map((i) => groupLabel(r, i)).join(", ")}`] : []),
  ];
  return html`${count}${made.length ? html` · ${made.join(" · ")}` : null}`;
}

// Each failure no patch's tests matched, as triage saw it, with what it rests on.
function pushAnalysis(r: RequestState, p: PushView): Html | null {
  if (!p.analysis?.length) {
    return null;
  }
  return html`<h4 class="part">What the factory made of its failures</h4><ul class="analysis">${p.analysis.map(
    (c) =>
      html`<li><b>${c.verdict}</b>${c.patch ? html` (${c.patch.slice(0, 12)})` : null}: ${c.test ? relativeTest(r, c.test) : (c.taskId ?? "a job")}${c.config ? html` <span class="sub">on ${c.config}</span>` : null}<div class="sub clamp1" data-expand title="Click to see all of it">${c.evidence}</div></li>`,
  )}</ul>`;
}

function relativeTest(r: RequestState, t: string): string {
  return r.folder && t.startsWith(`${r.folder}/`) ? t.slice(r.folder.length + 1) : t;
}

const DISCARDED = "discarded";

// Removes it, and nothing else happens.
function discardButton(r: RequestState, p: PushView): Html {
  return html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "decline-push", request: r.id, push: p.id, text: DISCARDED }], requestUrl(r.id))}<button class="btn small icon" title="Discard this push: it won't be made, and nothing else happens" aria-label="Discard">🗑</button></form>`;
}

// While it waits for you, or after you declined it without asking for a revision.
function revisable(r: RequestState, p: PushView): boolean {
  return !p.rev && !p.replan && (isWaiting(r, p) || (p.declined !== undefined && !p.withdrawn));
}

// The agent that planned it gets what you write, in its session, and plans what replaces it.
function reviseBox(r: RequestState, p: PushView): Html {
  const declined = p.declined !== undefined && p.declined !== DISCARDED ? p.declined : "";
  return html`<form class="cmd revise" method="post" action="/api/commands">${commandFields([{ cmd: "revise-push", request: r.id, push: p.id }], requestUrl(r.id))}<textarea name="text" required rows="2" placeholder="What should it run instead? The agent that planned it gets this; the plan's other pushes stay as they are">${declined}</textarea><button class="btn small">Revise</button></form>`;
}
