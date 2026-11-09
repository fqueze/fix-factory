import { ANNOTATIONS_ITEM, needsMetaBug as stackNeedsMetaBug, sameBugDraft } from "../../state/meta-bug.ts";
import { md } from "./md.ts";
import { REQUEST_STEPS } from "../commands.ts";
import type { BugDraft, ItemView, JobView, NeedsUser, PatchView, PushView, Regression, RequestState, ReviewPatchReport, ReviewerStatus, StackView } from "../../types.ts";
import { isAnswered } from "../../state/landing.ts";
import { escapeHtml, html, join, raw, type Html } from "../html.ts";
import { actionsSummary, flagPlaceOf, renderAction, recoveryAnswers, pollPhabButton, verifyStackButton, redoAnnotationsButton, approvePushControls, bugBox, continueBox, copyButton, handBackButton, flagControls, flagItemOf, flagText, plannedLabel, recoveryPlanFor, hasAuthorSession, stackViewerLink, submitControls, summaryId } from "./actions.ts";
import { groupJobs, jobLine } from "./activity.ts";
import { flagAsk, itemBucket, itemSentence, progressLine, requestProgress, submittedDetail, type Bucket } from "./progress.ts";
import {
  actionKind,
  bugUrl,
  commandFields,
  elapsed,
  enterBugUrl,
  metaBugUrl,
  foldContent,
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
  regressionStatus,
} from "./common.ts";

// One line per request; the body only when expanded, so the overview stays small.
export function renderRequest(r: RequestState, ctx: RenderContext, open = ctx.open?.includes(r.id) ?? false): Html {
  const needs = needsYou(r);
  const cost = requestCost(r);
  const summary = requestSummary(r);
  // One stack: its buttons are the request's, at the top right, and its meta bug, once filed, names the request.
  const stacks = liveStacks(r);
  const one = stacks.length === 1 ? stacks[0] : undefined;
  const meta = r.metaBug && hasBug(r.metaBug) ? r.metaBug : undefined;
  return html`<details class="req${needs ? " needs" : ""}" id="req-${r.id}" data-request="${r.id}" data-section="${sectionOf(r)}"${open ? html` open` : null}>
    <summary>
      <span class="rname">${meta ? html`<a class="bug" href="${bugUrl(meta.bug!)}" target="_blank" rel="noopener">Bug ${meta.bug}</a> ${r.metaBug!.draft?.summary ?? requestName(r)}` : requestName(r)}</span>
      <span class="rsum"><span class="rprog">${progressLine(requestProgress(r, ctx), submittedDetail(r, ctx))}</span>${summary ? ` · ${summary}` : null}</span>
      ${r.title && r.text.trim() ? html`<span class="rprompt" title="${r.text}">${r.text}</span>` : null}
      <span class="rright">${cost > 0 ? html`<a class="cost hide-sm" href="${profileUrl(ctx, r.id)}" target="_blank" rel="noopener" title="What the agents of this request cost so far: its profile">${formatCost(cost)}</a>` : null}${
        one ? html`${stackViewerLink(r, one)}${stackMenu(r, one, ctx)}` : null
      }</span>
      ${actionsSummary(r, ctx)}
    </summary>
    ${
      // Active ones come with their rows (what they hold is fetched as it opens); queued and finished ones when opened.
      open || sectionOf(r) === "active" ? reopen(renderRequestBody(r, ctx), ctx.openFolds?.get(r.id)) : html`<div class="rbody" data-lazy><a href="${requestUrl(r.id)}">Open this request</a></div>`
    }
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
  // Polling Phabricator is said in its ⋯ menu.
  const own = Object.values(r.jobs).filter((j) => j.item === undefined && j.endedAt === undefined && j.purpose?.push === undefined && j.name !== "phab.ts poll");
  parts.push(...new Set(own.map((j) => jobLabel(j.name))));
  // Once submitted, its progress says where its revisions stand, not try.
  const submitted = Object.values(r.patches).some((p) => p.revision !== undefined && !isDropped(r, p));
  if (r.step === "done" || (submitted && REQUEST_STEPS.indexOf(r.step) >= REQUEST_STEPS.indexOf("review comments"))) return parts.join(" · ");
  // Declined pushes say nothing about try; the last one made does, or one waiting for you.
  const pushes = Object.values(r.pushes).filter((p) => p.declined === undefined);
  const running = pushes.filter((p) => p.rev && p.result === undefined);
  const last = pushes.filter((p) => p.rev).at(-1) ?? pushes.at(-1);
  if (running.length > 1) {
    const sum = (k: "done" | "total" | "failures") => running.reduce((n, p) => n + (p.progress?.[k] ?? 0), 0);
    parts.push(`try: ${running.length} pushes, ${sum("done")}/${sum("total")}, ${plural(sum("failures"), "failure")}`);
  } else if (last) {
    // Its counts: the failed jobs are listed with the push.
    parts.push(`try: ${pushStatus(last).split(": ")[0]}`);
  }
  return parts.join(" · ");
}

// A landed patch leaves its stack, for the Landed section; a stack with nothing left isn't shown.
function liveStacks(r: RequestState): StackView[] {
  return Object.values(r.stacks).filter((s) => livePatches(r, s).length > 0);
}

// The folds you had open come open, as client.js would reopen them: a reload doesn't flash them collapsed.
function reopen(body: Html, folds: Set<string> | undefined): Html {
  if (!folds?.size) return body;
  const escaped = new Set([...folds].map(escapeHtml));
  return raw(body.value.replace(/<details\b[^>]*\bdata-fold="([^"]*)"[^>]*>/g, (tag, fold: string) => (escaped.has(fold) && !/\sopen[\s>]/.test(tag) ? `${tag.slice(0, -1)} open>` : tag)));
}

export function renderRequestBody(r: RequestState, ctx: RenderContext): Html {
  const back = requestUrl(r.id);
  const stacks = liveStacks(r);
  const stacked = new Set(Object.values(r.stacks).flatMap((s) => s.order));
  const stackedItems = new Set(stacks.flatMap((s) => livePatches(r, s).map((p) => p.item)));
  // Patches without a group (annotation patches) get a row of their own.
  const loose = Object.values(r.patches).filter((p) => !stacked.has(p.id) && itemOf(r, p) === undefined);
  const unstacked = Object.values(r.items).filter((i) => !stackedItems.has(i.id));
  // The abandoned groups come last, after what landed.
  const own = (i: ItemView) => Object.values(r.patches).filter((p) => p.item === i.id && !isDropped(r, p));
  // Groups whose patches landed have left their stack.
  // As Phabricator lists them: by their place in its stack (how many revisions are under them there), its top first.
  const byRevision = new Map(Object.values(r.patches).filter((p) => p.revision !== undefined).map((p) => [p.revision!, p]));
  const depth = (p: PatchView, seen = new Set<number>()): number => {
    const parent = p.review?.parent;
    if (parent === undefined || seen.has(parent) || !byRevision.has(parent)) return 0;
    return 1 + depth(byRevision.get(parent)!, seen.add(parent));
  };
  const rank = (i: ItemView) => Math.max(-1, ...own(i).map((p) => depth(p)));
  const landed = unstacked.filter((i) => i.state === "landed" || (own(i).length > 0 && own(i).every((p) => isLanded(r, p)))).sort((a, b) => rank(b) - rank(a));
  const items = unstacked.filter((i) => !landed.includes(i));
  // A group's landed patch while another of its patches is still in review: listed with what landed, in its place.
  const partly = Object.values(r.patches).filter((p) => p.item !== undefined && !landed.some((i) => i.id === p.item) && !isDropped(r, p) && isLanded(r, p));
  const landedRows = [...landed.map((i) => ({ at: rank(i), row: itemRows(r, i, ctx) })), ...partly.map((p) => ({ at: depth(p), row: patchRow(r, p, ctx) }))].sort((a, b) => b.at - a.at);
  // Newest first, as on Treeherder; those waiting for you are the newest anyway.
  const pushes = Object.values(r.pushes).reverse();
  const planned = pushes.filter((p) => isWaiting(r, p));
  const declined = pushes.filter((p) => !p.rev && p.declined !== undefined);
  const rest = pushes.filter((p) => !planned.includes(p) && !declined.includes(p));
  // In sight: the pushes waiting for you or running; the finished ones are a click away.
  const active = [...planned, ...rest.filter((p) => !p.result)];
  const finished = rest.filter((p) => p.result);
  const shownPlans = new Set(r.needsUser.map((n) => recoveryPlanFor(r, n)));
  const plans = r.recoveryPlans.filter((p) => !shownPlans.has(p));
  // A try push's jobs (push, watch) are on its row.
  const running = Object.values(r.jobs).filter((j) => j.item === undefined && j.endedAt === undefined && !(j.purpose?.push !== undefined && j.purpose.push in r.pushes));
  // What you told the factory in the box below is worked on right above it.
  const recovering = running.filter((j) => j.name === "recover");
  const others = running.filter((j) => j.name !== "recover");

  const repro = items.filter((i) => i.state === "waiting for a try repro");
  const toStack = items.filter((i) => i.state !== "waiting for a try repro");
  return html`<div class="rbody">
    ${others.length ? html`<div class="jobs">${others.map((j) => jobLine(r, j, ctx))}</div>` : null}
    ${configLine(r)}
    ${splitLine(r)}
    ${pushes.length ? html`${active.length ? html`<h3>Try pushes${planned.length > 1 ? html` ${approvePushControls(r, planned, back)}` : null}</h3><div class="rows">${active.map((p) => pushRowOf(r, p, ctx))}</div>` : null}${
      finished.length || declined.length
        ? html`<details class="fold pushes" data-fold="finished-pushes"><summary>${plural(finished.length, active.length ? "finished try push" : "try push")}${declined.length ? `, ${declined.length} declined or withdrawn` : ""}</summary>${foldContent(
            r,
            ctx,
            "finished-pushes",
            () =>
              html`<div class="rows">${finished.map((p) => pushRowOf(r, p, ctx))}${
                declined.length ? html`<details class="fold" data-fold="declined-pushes"><summary>${declined.length} declined or withdrawn</summary>${foldContent(r, ctx, "declined-pushes", () => html`<div class="rows">${declined.map((p) => pushRowOf(r, p, ctx))}</div>`)}</details>` : null
              }</div>`,
          )}</details>`
        : null
    }` : null}${stacks.length === 1 ? stackSubmit(r, stacks[0], ctx) : null}${pushes.length || stacks.length === 1 ? html`<hr class="part">` : null}
    ${r.metaBug && !(hasBug(r.metaBug) && (stacks.length || landed.length)) ? metaBugLine(r, back, ctx) : null}
    ${stacks.map((s) => stackSection(r, s, ctx, stacks.length > 1))}
    ${loose.length ? html`<h3>Patches</h3><div class="rows">${loose.map((p) => patchRow(r, p, ctx))}</div>` : null}
    ${
      // Groups with only DEBUG commits aren't on their way into the stack: those commits ride on top of its next push.
      repro.length ? html`<h3>DEBUG commits for the stack's next try push</h3>${groupRows(r, repro, ctx, false)}` : null
    }
    ${toStack.some((i) => itemBucket(r, i, ctx) !== "closed") ? html`${stacks.length || loose.length ? html`<h3>Not in a stack yet</h3>` : null}${groupRows(r, toStack, ctx, false)}` : null}
    ${landedRows.length ? html`<div class="landed-section"><h3 class="landed-head">Landed</h3><div class="landed-rows compact-rows"><div class="rows">${landedRows.map((x) => x.row)}</div></div></div>` : null}
    ${closedSection(handOffs(r, ctx), closedFold(r, items.filter((i) => itemBucket(r, i, ctx) === "closed" && i.state !== "taken over"), ctx))}
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
// The requests a split made, and the one it came from.
function splitLine(r: RequestState): Html | null {
  const link = (id: string) => html`<a href="${requestUrl(id)}">${id}</a>`;
  if (r.splitInto) {
    return html`<div class="sub" style="margin-top:6px">Split into ${join(r.splitInto.map(link), ", ")}: its groups, patches and pushes went there.</div>`;
  }
  return r.splitFrom ? html`<div class="sub" style="margin-top:6px">Split from ${link(r.splitFrom)}, whose try pushes it keeps.</div>` : null;
}

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

// Its header only when the request has several: one stack's title and buttons are the request's.
function stackSection(r: RequestState, s: StackView, ctx: RenderContext, header: boolean): Html {
  const patches = livePatches(r, s);
  const dropped = patches.filter((p) => isDropped(r, p));
  // Once the meta bug is filed, it names the stack.
  const meta = r.metaBug && hasBug(r.metaBug) ? r.metaBug : undefined;
  const title = meta ? html`<a class="bug" href="${bugUrl(meta.bug!)}" target="_blank" rel="noopener">Bug ${meta.bug}</a> ${r.metaBug?.draft?.summary ?? s.folder}` : html`${s.folder}`;
  const submitted = patches.some((p) => p.revision !== undefined) && r.step !== "done";
  return html`${header ? html`<h3 class="stackhead"><span title="Branch ${s.branch}; as on Phabricator, its top first: in review order from the bottom up, easy and valuable first, each after its hard deps">${title}</span>${stackViewerLink(r, s)}${stackMenu(r, s, ctx)}</h3>` : null}
    ${r.needsUser.filter((n) => flagItemOf(r, n) === undefined && n.patch === undefined && n.stack === s.id && flagPlaceOf(r, n) !== undefined).map((n) => renderAction(r, n, ctx))}
    ${optionalMetaBug(r, s, ctx)}
    <div class="rows">${patchRows(
      r,
      // As Phabricator lists a stack: its top (last commit) first.
      patches.filter((p) => !isDropped(r, p)).reverse(),
      ctx,
    )}${
      dropped.length ? html`<details class="fold" data-fold="dropped-${s.id}"><summary>${dropped.length} dropped</summary><div class="rows">${dropped.map((p) => patchRow(r, p, ctx))}</div></details>` : null
    }</div>
    ${header ? stackSubmit(r, s, ctx, submitted) : null}`;
}

// Verifying and submitting the stack: with one stack, right under the try pushes (so its rows meet what landed below
// them); with several, under each.
function stackSubmit(r: RequestState, s: StackView, ctx: RenderContext, submitted = livePatches(r, s).some((p) => p.revision !== undefined) && r.step !== "done"): Html {
  return html`<div class="stack-submit">${submitted ? verifyStackButton(r.id, requestUrl(r.id)) : null}${submitControls(r, s, requestUrl(r.id), ctx)}</div>`;
}

function stackMenu(r: RequestState, s: StackView, ctx: RenderContext): Html | null {
  return stackPatches(r, s).some((p) => p.revision !== undefined) && r.step !== "done" ? phabCheck(r, ctx) : null;
}

// When Phabricator was last read, and the button to read it now; "checking" while it's read.
function phabCheck(r: RequestState, ctx: RenderContext): Html {
  const polls = Object.values(r.jobs).filter((j) => j.name === "phab.ts poll");
  const checking = polls.some((j) => j.endedAt === undefined);
  // Rarely needed: in a ⋯ menu, which stays where it is while Phabricator is read.
  const last = polls.filter((j) => j.exitCode === 0).map((j) => j.endedAt!).sort().at(-1);
  return html`<details class="menu"><summary class="btn small" title="${checking ? "Checking Phabricator…" : "More"}">⋯</summary><div class="menu-items">${
    checking ? html`<span class="sub working">checking Phabricator…</span>` : pollPhabButton(r.id, requestUrl(r.id))
  }${last ? html`<span class="sub">last checked ${elapsed(last, ctx)} ago</span>` : null}</div></details>`;
}

// The bugs of the stacks' patches, which a meta bug tracks.
function stackBugs(r: RequestState): number[] {
  return [...new Set(Object.values(r.stacks).flatMap((s) => stackPatches(r, s)).flatMap((p) => (hasBug(p) ? [p.bug] : [])))];
}

// Outside burndowns, there's no drafted meta bug: when nothing needs one, filing one to track the stack's bugs is up to
// you, and doesn't hold back submitting.
function optionalMetaBug(r: RequestState, s: StackView, ctx: RenderContext): Html | null {
  // A burndown's meta bug is drafted by an agent, as is another request's when you ask: shown with the meta bug's
  // box once written.
  if (r.metaBug || r.kind === "burndown") return null;
  const lead = stackNeedsMetaBug(stackPatches(r, s)) ? "This stack needs a meta bug, for its annotation patches" : "A meta bug is optional here";
  const drafting = Object.values(r.jobs).some((j) => j.name === "write-meta-bug" && j.endedAt === undefined);
  return html`<div class="metabug sub">${lead}: ${
    drafting
      ? "its draft is being written"
      : html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "draft-meta-bug", request: r.id }], requestUrl(r.id))}<button class="btn small">Draft it</button></form>`
  }, or paste the number of one you filed ${bugBox(r.id, "meta", requestUrl(r.id))}</div>`;
}

// One line per group or patch: its name and cost, then where it stands. Opening it shows the rest
// under it, its jobs open on what their agent did.
interface Row {
  anchor: Html; // its id and data- attributes
  fold: string;
  cls: StateClass;
  tip?: string; // what its icon means, when not what it means for a group or patch
  name: Html;
  title: string;
  end: Html | null;
  state: Html;
  trust?: Html | null; // the evidence and reproduction behind it, once opened
  flag?: Html | null; // what it waits for you to do on Phabricator, with its buttons, on a line of its own
  warn?: Html | null; // what you should know before answering, under its state
  ask?: Html; // what a group needing you asks, with its buttons: in sight without opening the row
  under?: Html | null; // opened, right under its name: a patch's bug to file
  body: Html | (() => Html); // a function: rendered once opened (see foldContent)
  lazy?: { r: RequestState; ctx: RenderContext };
  you?: boolean; // waiting for you: the whole row stands out
  bucket?: Bucket; // its color on its left edge, as in the progress bar
}

// Opened, the box under its name comes first in the body (clicking in it mustn't fold the row), styled as hanging
// from its label; its state and trust lines then move under the box.
function row(x: Row): Html {
  const lines = html`<span class="state">${x.state}</span>${x.flag ? html`<span class="rowflag">${x.flag}</span>` : null}${x.trust ? html`<span class="trust">${x.trust}</span>` : null}`;
  const d = html`<details class="row${x.you ? " you" : null}${x.bucket ? ` b-${x.bucket.replaceAll(" ", "-")}` : null}" ${x.anchor} data-fold="${x.fold}"><summary><span class="st ${x.cls}" title="${x.tip ?? ICON_TIPS[x.cls]}"></span><span class="name" title="${x.title}">${x.name}</span><span class="end">${x.end}</span>${lines}${
    x.warn ? html`<span class="warn">${x.warn}</span>` : null
  }</summary>${x.under ? html`<div class="under">${x.under}<div class="lines">${raw(lines.value.replace(/ id="patch-[^"]*"/g, ""))}</div></div>` : null}<div class="rowbody">${
    typeof x.body === "function" ? (x.lazy ? foldContent(x.lazy.r, x.lazy.ctx, x.fold, x.body) : x.body()) : x.body
  }</div></details>`;
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

// The groups you took over, with their patches, and the prompt for your session to copy (folded below).
function handOffs(r: RequestState, ctx: RenderContext): Html | null {
  const taken = Object.values(r.items).filter((i) => i.state === "taken over");
  if (!taken.length) {
    return null;
  }
  return html`<h3>Taken over by you</h3>${r.handOffs.map((h) => {
    const id = `hand-off-${h.job}`;
    return html`<div class="handoff"><div class="testplanctl"><textarea hidden id="${id}">${h.text}</textarea><button type="button" class="btn small primary" data-copy="${id}">Copy the prompt for your session</button><span class="sub">written ${formatDate(h.t)}</span></div><details class="fold" data-fold="${id}"><summary>the prompt</summary><div class="testplan">${md(h.text)}</div></details></div>`;
  })}<div class="rows">${taken.map((i) => itemRows(r, i, ctx))}</div>`;
}

// What the factory no longer works on, taken over or closed: one grey edge down its headers and rows, as Landed's.
function closedSection(...parts: (Html | null)[]): Html | null {
  return parts.some((x) => x !== null) ? html`<div class="closed-section">${parts}</div>` : null;
}

function closedFold(r: RequestState, closed: ItemView[], ctx: RenderContext): Html | null {
  return closed.length ? html`<details class="fold" data-fold="closed-groups"><summary>${closed.length} closed</summary>${foldContent(r, ctx, "closed-groups", () => html`<div class="rows compact-rows">${closed.map((i) => itemRows(r, i, ctx))}</div>`)}</details>` : null;
}

// Once a group has a reviewed patch, the patch's row replaces the group's.
function itemRows(r: RequestState, i: ItemView, ctx: RenderContext): Html {
  // A commit its author squashed away stays a patch of the group, outside every stack, while a sibling is in one.
  const stacked = new Set(Object.values(r.stacks).flatMap((s) => s.order));
  const own = Object.values(r.patches).filter((p) => p.item === i.id && !isDraft(r, p) && !isDropped(r, p));
  const live = own.some((p) => stacked.has(p.id)) ? own.filter((p) => stacked.has(p.id)) : own;
  return live.length ? patchRows(r, live, ctx) : groupRow(r, i, ctx);
}

function itemCost(r: RequestState, i: ItemView): number {
  return i.jobs.reduce((sum, j) => sum + (r.jobs[j].costUsd ?? 0), 0);
}

// A group's cost opens its own profile.
function costLabel(r: RequestState, i: ItemView, ctx: RenderContext): Html | null {
  const usd = itemCost(r, i);
  return usd > 0 ? html`<a class="cost" href="${profileUrl(ctx, r.id, i.id)}" target="_blank" rel="noopener" title="Agent cost of this group so far: its profile">${formatCost(usd)}</a>` : null;
}

function stateText(r: RequestState, i: ItemView, ctx: RenderContext): Html {
  const s = itemSentence(r, i, ctx);
  return html`${s.text}${s.detail ? `: ${s.detail}` : null}`;
}

// A ready group or patch gets the ✓, even while it waits for the rest of its stack.
// A closed group's icon, in words: what closed it.
function closedTip(r: RequestState, i: ItemView): string | undefined {
  if (r.movedTo?.[i.id]) return `Moved to ${r.movedTo[i.id]}`;
  if (i.state === "taken over") return "Taken over by you";
  if (i.state === "handed back") return "Dropped by you: the factory stopped working on it";
  if (i.state === "left as-is") return `Left as-is${i.detail ? `: ${i.detail}` : ""}`;
  return undefined;
}

// What a group's or patch's icon means.
const ICON_TIPS: Record<StateClass, string> = {
  run: "The factory is working on it",
  wait: "Waiting: for try, another group, or a free slot",
  find: "Needs you",
  ok: "Ready: nothing left for the factory to do",
  closed: "Closed: dropped, left as-is or handed back",
  accepted: "Accepted on Phabricator",
  review: "Needs review on Phabricator",
  landed: "Landed (closed on Phabricator)",
  abandoned: "Abandoned on Phabricator",
  handedover: "Handed over to someone else",
  draft: "Ready to submit: nothing left for the factory to do",
  resubmit: "To resubmit: it changed since Phabricator got it",
  dropped: "Dropped by you: the factory stopped working on it",
};

// A ready patch on Phabricator gets its icon there: accepted (✓), waiting for review (</>), landed (☑); an abandoned
// one, ✈, whatever its group.
function phabClass(p: PatchView, cls: StateClass): StateClass {
  if (p.review?.status === "abandoned") return "abandoned";
  if (cls !== "ok") return cls;
  // Not submitted yet: Phabricator's draft.
  if (p.revision === undefined) return "draft";
  return ({ published: "landed", accepted: "accepted", "needs-review": "review" } as const)[p.review?.status as "published" | "accepted" | "needs-review"] ?? cls;
}

function rowClass(r: RequestState, i: ItemView, ctx: RenderContext): StateClass {
  // Closed: ✈ handed over to someone else (moved, taken over by you), ✕ dropped by you or closed.
  if (i.state === "taken over" || r.movedTo?.[i.id]) return "handedover";
  if (i.state === "handed back") return "dropped";
  if (itemSentence(r, i, ctx).cls === "closed") return "abandoned";
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
    bucket: itemBucket(r, i, ctx),
    cls: rowClass(r, i, ctx),
    tip: closedTip(r, i) ?? (rowClass(r, i, ctx) === "abandoned" ? "Closed without a fix" : undefined),
    name: html`${groupLabel(r, i)}`,
    title: [...i.group.tests, i.group.configs.join(", ")].join("\n"),
    // Redo is on the top line: the group's patches are in its folded body, and it's what you'd want of it.
    end: i.id === ANNOTATIONS_ITEM && !Object.values(r.jobs).some((j) => j.item === i.id && j.endedAt === undefined)
      ? html`${redoAnnotationsButton(r.id, requestUrl(r.id))} ${costLabel(r, i, ctx)}`
      : html`${closable(r, i, ctx) ? html`<span class="onhover">${closeButton(r, i)}</span>` : null}${costLabel(r, i, ctx)}`,
    state: stateText(r, i, ctx),
    trust: trustLine(r, i, ctx),
    ask: askBlock(r, i, ctx, patches.filter((p) => isDraft(r, p))),
    lazy: { r, ctx },
    body: () => html`${failure(r, i)}${investigationHtml(i) ? html`<h4 class="part">The fix</h4>${investigationHtml(i)}` : null}${debugCommitsHtml(r, i)}${talkBox(r, i, ctx)}${sentence.ask ? null : sentence.controls ? html`<div class="jobctl">${sentence.controls}</div>` : null}${patches
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
// On a patch's row, what you say is a comment on its fix: listed under Your comments with its answer.
function talkBox(r: RequestState, i: ItemView, ctx: RenderContext, p?: PatchView): Html | null {
  const s = itemSentence(r, i, ctx);
  if (s.ask || s.cls === "run" || ["fixed", "landed", "left as-is", "handed back", "taken over"].includes(i.state)) {
    return null;
  }
  if (!hasAuthorSession(r, i.id)) return null;
  return html`<div class="jobctl">${
    p
      ? html`<form class="inline cmd joined" method="post" action="/api/commands">${commandFields([{ cmd: "comment-fix", request: r.id, patch: p.id }], requestUrl(r.id))}<input type="text" name="text" required placeholder="Tell its author what to do…"><button class="btn small" title="Resumes its author's session with your message; its patch then goes through lint and critical review again">Send</button></form>`
      : continueBox(r.id, i.id, requestUrl(r.id))
  }</div>`;
}

// Whether the factory may still be told to drop a group: the row's 🗑.
function closable(r: RequestState, i: ItemView, ctx: RenderContext): boolean {
  const s = itemSentence(r, i, ctx);
  return !s.ask && s.cls !== "run" && !["fixed", "landed", "left as-is", "handed back", "taken over"].includes(i.state);
}

function closeButton(r: RequestState, i: ItemView): Html {
  return handBackButton(r.id, i.id, requestUrl(r.id));
}

// Agents can't push to try; you can let its author make one push (it may be running).
// The failure a group is about: its message, its tests when there are several, and where it failed, laid out like
// tests.firefox.dev's pass/fail table (its rates are a click away).
function failure(r: RequestState, i: ItemView, prefix: string | null = "The failure"): Html {
  const g = i.group;
  const tests = g.tests.length > 1 ? g.tests.map((t) => (r.folder && t.startsWith(`${r.folder}/`) ? t.slice(r.folder.length + 1) : t)).join(", ") : null;
  const dashboard = /\.(toml|ini)$/.test(g.tests[0]) ? null : html` · <a href="https://tests.firefox.dev/test.html?test=${encodeURIComponent(g.tests[0])}" target="_blank" rel="noopener">rates on tests.firefox.dev ↗</a>`;
  const rate = g.ratePerWeek === undefined ? null : html` · ${g.ratePerWeek} failures/week`;
  return html`${prefix === null ? null : html`<h4 class="part">${prefix}</h4>`}<div class="failure">${g.message}</div>${tests ? html`<div class="sub">${tests}</div>` : null}${
    g.configs.length ? html`${configTable(g.configs)}<div class="sub">${plural(g.configs.length, "config")}${rate}${dashboard}</div>` : null
  }`;
}

// On a patch's row, folded: the failure in one sentence, then its cause.
function whyFold(r: RequestState, i: ItemView): Html {
  return html`<details class="fold" data-fold="why-${i.id}"><summary>The failure and its cause</summary>${failureLine(r, i)}${investigationHtml(i)}</details>`;
}

// The harness's words for a failure it retried in a fresh browser, which say nothing on their own.
const RETRIED = /^Test had failures, will retry$/;

// “Failed, then passed when retried in a fresh browser · 3 failures/week · rates on tests.firefox.dev ↗”, then where,
// laid out like tests.firefox.dev's pass/fail table.
function failureLine(r: RequestState, i: ItemView): Html {
  const g = i.group;
  const what = RETRIED.test(g.message) ? "Failed, then passed when retried in a fresh browser" : g.message;
  const rate = g.ratePerWeek === undefined ? null : html` · ${g.ratePerWeek} failures/week`;
  const dashboard = /\.(toml|ini)$/.test(g.tests[0]) ? null : html` · <a href="https://tests.firefox.dev/test.html?test=${encodeURIComponent(g.tests[0])}" target="_blank" rel="noopener">rates on tests.firefox.dev ↗</a>`;
  return html`<div class="failure">${what}${rate}${dashboard}</div>${g.configs.length ? configTable(g.configs) : null}`;
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

// What a patch shows of itself, whether alone on its row or as a line of its fix's row.
function patchParts(r: RequestState, p: PatchView, ctx: RenderContext) {
  const back = requestUrl(r.id);
  const item = itemOf(r, p);
  const landable = isLandable(r, p);
  // Patches sharing a bug draft have it filed once, from the first one's row.
  const first = sameBugDraft(r, p.id)[0];
  const bugBoxShown = !hasBug(p) && p.bugDraft !== undefined && first.id === p.id;
  // What it waits for you to do (resubmit after review fixes, file its bug…), said on the row; those about no group are
  // asked right under it.
  const yours = r.needsUser.filter((n) => n.patch === p.id);
  // Resubmitting or posting replies: a line of the row; anything else it asks, in the box under it.
  const onLine = (n: NeedsUser) => ["resubmit", "reply"].includes(actionKind(n, r));
  const own = yours.filter((n) => flagItemOf(r, n) === undefined && flagPlaceOf(r, n) !== undefined);
  return {
    item,
    landable,
    bugBoxShown,
    yours,
    own,
    onLine,
    cls: own.some((n) => actionKind(n, r) === "resubmit") ? ("resubmit" as StateClass) : phabClass(p, item ? rowClass(r, item, ctx) : landable ? "ok" : "wait"),
    name: html`${p.revision ? html`<a class="phab" href="${phabUrl(p.revision)}" title="D${p.revision}" target="_blank" rel="noopener">${PHAB_ICON}</a>` : null}${
      first.id === p.id ? bugLabel(p, ctx) : html`<a class="bug tofile" href="#patch-${first.id}" title="Filed from ${first.title}">same bug</a>`
    } <span class="ptitle">${patchTitle(p)}</span>`,
    // On a fix's row: its bug, once for the patches that share it, then its revision and title.
    bug: first.id === p.id ? bugLabel(p, ctx) : bugLabel(first, ctx),
    bugKey: hasBug(p) ? `bug ${p.bug}` : `draft ${first.id}`,
    title: html`${p.revision ? html`<a class="phab" href="${phabUrl(p.revision)}" title="D${p.revision}" target="_blank" rel="noopener">${PHAB_ICON}</a>` : null}${patchTitle(p)}`,
    end: html`${hoverInfo(r, p, item, ctx)}${viewLink(r, p)}`,
    // Where its review stands, whether it can land, what you need to do about it.
    status: [
      p.review && (item?.state === "waiting for review" || !item) ? html`${reviewText(p)}` : null,
      landable ? html`<span class="landable">landable</span>` : null,
      backoutText(r, p),
      r.tryNeeded?.[p.id] && !r.tryNeeded[p.id].verified ? html`<span class="bad" title="Not landable yet: it was changed for ${r.tryNeeded[p.id].why}, and no green try push has carried that change since">needs a green try push</span>` : null,
      ...yours.filter((n) => !own.includes(n) || !onLine(n)).map((n) => html`<b class="you">${n.action}</b>`),
    ].filter((x) => x !== null),
    flag: own.some(onLine) ? html`${own.filter(onLine).map((n) => html`<span class="flagitem" data-key="${n.key}"><b>${n.action}</b>${n.detail ? html` <span class="sub">${n.detail}</span>` : null}${flagControls(r, n, ctx)}</span>`)}` : null,
    rest: own.filter((n) => !onLine(n)).map((n) => renderAction(r, n, ctx)),
    under: bugBoxShown ? bugDraftBox(r, p, back) : null,
    body: () => html`${testPlanSection(r, p, back)}${yourComments(r, p)}${p.deps.map((d) => depLine(r, d))}${reviewBox(r, p, p.interdiffFile === undefined ? undefined : ctx.interdiff?.(p))}${leftFindings(r, p, ctx)}`,
  };
}

function patchRow(r: RequestState, p: PatchView, ctx: RenderContext): Html {
  const parts = patchParts(r, p, ctx);
  const { item, landable } = parts;
  const sentence = item ? itemSentence(r, item, ctx) : undefined;
  // Groups whose own fix was dropped because this patch fixes them too.
  const covered = Object.values(r.items).filter((i) => i.coveredBy === p.id);
  // A "file the bug" ⚑'s buttons are the bug box's.
  const controls = parts.bugBoxShown && r.needsUser.some((n) => n.patch === p.id && actionKind(n, r) === "file-bug") ? null : sentence?.controls;
  // A group's question is asked once, on the row of its first patch.
  // A blocked group's patch still in its stack counts: that row is the only one it has.
  const stacked = new Set(Object.values(r.stacks).flatMap((st) => st.order));
  const asks = item !== undefined && Object.values(r.patches).find((x) => x.item === item.id && (!isDraft(r, x) || stacked.has(x.id)) && !isDropped(r, x)) === p;
  return row({
    you: parts.yours.length > 0 || (asks && item !== undefined && r.needsUser.some((n) => flagItemOf(r, n) === item.id)),
    anchor: html`id="patch-${p.id}" data-patch="${p.id}"`,
    fold: `patch-${p.id}`,
    bucket: item ? (landable && itemBucket(r, item, ctx) === "ready" ? "landable" : itemBucket(r, item, ctx)) : landable ? "landable" : undefined,
    cls: parts.cls,
    tip: item && p.review?.status !== "abandoned" ? closedTip(r, item) : undefined,
    name: parts.name,
    title: p.title,
    end: html`${parts.end}${item ? costLabel(r, item, ctx) : null}`,
    // "in the stack" says nothing a patch row in its stack's section doesn't.
    // What matters most first (where its review stands, landable, what you need to do): a long list of tests is cut off.
    state: html`${[
      item ? (item.state === "in stack" || item.state === "landed" ? null : item.state === "waiting for review" && p.review ? null : item.state === "waiting for review" && p.revision === undefined ? html`reviewed, not submitted yet` : html`${stateText(r, item, ctx)}`) : null,
      ...parts.status,
      item ? html`fixes <b>${groupLinks(r, item)}</b>${covered.length ? html` and <b>${join(covered.map((i) => groupLinks(r, i)), ", ")}</b>` : null}` : null,
    ]
      .filter((x) => x !== null)
      .map((x, i) => (i ? html` · ${x}` : x))}`,
    trust: item ? trustLine(r, item, ctx) : null,
    flag: parts.flag,
    ask: (() => {
      const group = item && asks ? askBlock(r, item, ctx, [], controls !== null) : undefined;
      return group || parts.rest.length ? html`${group}${parts.rest}` : undefined;
    })(),
    under: parts.under,
    lazy: { r, ctx },
    body: () => html`${item ? whyFold(r, item) : null}${parts.body()}${controls && !sentence?.ask ? html`<div class="jobctl">${controls}</div>` : null}${
      item ? html`<h4 class="part">What the factory did</h4>${itemJobs(r, item, ctx)}${talkBox(r, item, ctx, p)}` : null
    }`,
  });
}

// A fix of several patches: one row, a line per patch (its icon, review, landable, what it waits for you to do) in sight,
// what's the fix's (its state, evidence, question, agents) once.
function fixRow(r: RequestState, ps: PatchView[], ctx: RenderContext): Html {
  const item = itemOf(r, ps[0])!;
  const parts = ps.map((p) => patchParts(r, p, ctx));
  const sentence = itemSentence(r, item, ctx);
  const covered = Object.values(r.items).filter((i) => ps.some((p) => i.coveredBy === p.id));
  const landable = parts.every((x) => x.landable);
  // Each patch's title where a row's name is, its own links at its end; under it, what's its own (its review, landable,
  // what it waits for you to do).
  // A grid row per patch line and per line under it; a bug its patches share spans all of theirs.
  const gridRows = (n: number) => 1 + (parts[n].status.length ? 1 : 0) + (parts[n].flag ? 1 : 0);
  const span = (n: number) => {
    let rows = gridRows(n);
    for (let k = n + 1; k < ps.length && parts[k].bugKey === parts[n].bugKey; k++) rows += gridRows(k);
    return rows;
  };
  const names = html`${ps.map(
    (p, n) =>
      html`<span class="patchline" id="patch-${p.id}" data-patch="${p.id}">${
        n > 0 && parts[n - 1].bugKey === parts[n].bugKey ? null : html`<span class="pbug" style="grid-row: span ${span(n)}">${parts[n].bug}</span>`
      }<span class="pname" title="${p.title}">${parts[n].title}</span><span class="end">${parts[n].end}</span>${
        parts[n].status.length ? html`<span class="pstate">${join(parts[n].status, " · ")}</span>` : null
      }${parts[n].flag ? html`<span class="rowflag">${parts[n].flag}</span>` : null}</span>`,
  )}`;
  const controls = parts.some((x) => x.bugBoxShown) && r.needsUser.some((n) => ps.some((p) => n.patch === p.id) && actionKind(n, r) === "file-bug") ? null : sentence.controls;
  return row({
    you: parts.some((x) => x.yours.length > 0) || r.needsUser.some((n) => flagItemOf(r, n) === item.id),
    anchor: html`id="fix-${item.id}" data-item="${item.id}"`,
    fold: `fix-${item.id}`,
    bucket: landable && itemBucket(r, item, ctx) === "ready" ? "landable" : itemBucket(r, item, ctx),
    cls: phabClass(ps[0], rowClass(r, item, ctx)),
    tip: closedTip(r, item),
    name: html`<span class="patchlines">${names}</span>`,
    title: ps.map((p) => p.title).join("\n"),
    end: costLabel(r, item, ctx),
    state: html`${[
      item.state === "in stack" || item.state === "landed" || item.state === "waiting for review" ? null : html`${stateText(r, item, ctx)}`,
      html`fixes <b>${groupLinks(r, item)}</b>${covered.length ? html` and <b>${join(covered.map((i) => groupLinks(r, i)), ", ")}</b>` : null}`,
    ]
      .filter((x) => x !== null)
      .map((x, i) => (i ? html` · ${x}` : x))}`,
    trust: trustLine(r, item, ctx),
    ask: (() => {
      const group = askBlock(r, item, ctx, [], controls !== null);
      const rest = parts.flatMap((x) => x.rest);
      return group || rest.length ? html`${group}${rest}` : undefined;
    })(),
    under: parts.some((x) => x.under) ? html`${parts.map((x) => x.under)}` : null,
    lazy: { r, ctx },
    body: () => html`${whyFold(r, item)}${ps.map((p, n) => {
      const b = parts[n].body();
      return b.value.trim() ? html`<h4 class="part">${patchTitle(p)}</h4>${b}` : null;
    })}${controls && !sentence.ask ? html`<div class="jobctl">${controls}</div>` : null}<h4 class="part">What the factory did</h4>${itemJobs(r, item, ctx)}${talkBox(r, item, ctx, ps[0])}`,
  });
}

// Rows of patches in order, a fix's patches next to each other in one.
function patchRows(r: RequestState, ps: PatchView[], ctx: RenderContext): Html {
  const out: Html[] = [];
  for (let n = 0; n < ps.length; n++) {
    const run = [ps[n]];
    while (ps[n].item !== undefined && ps[n + 1]?.item === ps[n].item) run.push(ps[++n]);
    out.push(run.length > 1 ? fixRow(r, run, ctx) : patchRow(r, run[0], ctx));
  }
  return html`${out}`;
}

// What you told its author, each with the answer of the run it started (its summary starts with one line per point).
function yourComments(r: RequestState, p: PatchView): Html | null {
  if (!p.yourComments?.length) {
    return null;
  }
  const answer = (key: string): Html => {
    const job = Object.values(r.jobs).findLast((j) => j.purpose?.key === key);
    if (!job) return html`<span class="sub">not answered yet</span>`;
    if (job.endedAt === undefined) return html`<span class="working">being answered</span>`;
    const text = job.said ?? job.outcome;
    return text ? html`${md(text)}` : html`<span class="sub">${job.error ?? "no answer"}</span>`;
  };
  return html`<h4 class="part">Your comments</h4>${p.yourComments.map((c) => html`<div class="yourcomment"><div class="comment-text">${md(c.text)}</div><div class="answer"><b>Its answer</b>${answer(c.key)}</div></div>`)}`;
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
  const revise =
    p.testPlan === undefined
      ? null
      : html`<form class="cmd revise joined" method="post" action="/api/commands">${commandFields([{ cmd: "revise-test-plan", request: r.id, patch: p.id }], back)}<textarea name="text" required rows="2" placeholder="What should change? The agent that wrote it gets this"></textarea><button class="btn small" title="Enter sends; Shift+Enter for a new line">Send</button></form>`;
  return html`<div class="parthead"><h4 class="part">Test plan</h4>${status}<textarea hidden id="${id}">${text}</textarea><button type="button" class="btn small" data-copy="${id}">Copy</button>${set}</div><div class="testplan">${md(text, itemOf(r, p)?.group.tests)}${revise}</div>`;
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
  return html`<div class="why">${md(`Cause: ${inv.cause}`, i.group.tests)}</div>`;
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
  return jobs.length ? html`<details class="fold" data-fold="jobs"><summary>${plural(jobs.length, "task")}</summary>${foldContent(r, ctx, "jobs", () => html`<div class="jobs">${jobs.map((j) => jobLine(r, j, ctx))}</div>`)}</details>` : null;
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
  const jobs = Object.values(r.jobs).filter((j) => (j.purpose?.what === "revise-draft" && j.purpose.patch === patch) || (patch === "meta" && j.purpose?.what === "meta-draft" && j.purpose.key.includes(":revise:")));
  return jobs.length
    ? html`<div class="revisions">${jobs.map(
        (j) =>
          html`<div class="sub">${j.endedAt === undefined ? "Revising it after" : j.exitCode === 0 ? "Revised after" : "Couldn't revise it after"} your comment${j.purpose!.reason === undefined ? null : html` “${j.purpose!.reason}”`} · ${formatDate(j.startedAt)}${
            (j.said ?? j.outcome) ? html`<div class="answer"><b>It answered:</b> ${md(j.said ?? j.outcome!)}</div>` : null
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

// Who it waits for on Phabricator, or who accepted it or asked for changes.
// Where its revision stands, then each reviewer with its icon as on Phabricator.
const REVIEWER_TIPS: Record<ReviewerStatus["status"], string> = {
  accepted: "accepted",
  "accepted-prior": "accepted a prior diff",
  pending: "hasn't reviewed it yet",
  required: "is a blocking reviewer and hasn't reviewed it yet",
  blocking: "requested changes",
  "rejected-prior": "requested changes on a prior diff",
  resigned: "resigned",
};
function reviewText(p: PatchView): Html {
  const rv = p.review!;
  const what =
    rv.status === "accepted"
      ? "accepted"
      : rv.reviewers.some((x) => x.status === "blocking")
        ? "changes requested"
        : (({ "needs-review": "waiting for review", published: "landed", abandoned: "abandoned" }) as Record<string, string>)[rv.status] ?? rv.status;
  return html`${what}${rv.reviewers.length ? html`: ${join(rv.reviewers.map((x) => html`<span class="rv ${x.status}" title="${x.name} ${REVIEWER_TIPS[x.status]}">${x.name}</span>`), " ")}` : null}`;
}

// On the row's first line, shown on hover: its review effort (why, in its title), its size, and the 🗑 to close it.
function hoverInfo(r: RequestState, p: PatchView, item: ItemView | undefined, ctx: RenderContext): Html | null {
  const why = Object.values(r.jobs).findLast((j) => j.purpose?.what === "effort" && j.purpose.patch === p.id)?.outcome;
  const stat = ctx.diffStat?.(p);
  const parts = [
    p.effort === undefined ? null : html`<span${why ? html` title="${why}"` : null}>review effort ${p.effort}/5</span>`,
    stat ? html`<span class="stat"><span class="add">+${stat.added}</span> <span class="del">−${stat.removed}</span></span>` : null,
    rowMenu(r, p, item, ctx),
  ].filter((x) => x !== null);
  return parts.length ? html`<span class="onhover">${parts}</span>` : null;
}

// What's rarely needed on a patch's row, in a ⋯ menu: checking Phabricator now, dropping its group.
function rowMenu(r: RequestState, p: PatchView, item: ItemView | undefined, ctx: RenderContext): Html | null {
  const items = [p.revision !== undefined && r.step !== "done" ? pollPhabButton(r.id, requestUrl(r.id)) : null, item && closable(r, item, ctx) ? handBackButton(r.id, item.id, requestUrl(r.id), "Drop") : null].filter((x) => x !== null);
  return items.length ? html`<details class="menu"><summary class="btn small" title="More">⋯</summary><div class="menu-items">${items}</div></details>` : null;
}

// Interdiff, the comments still to answer, and the drafted replies to post.
function reviewBox(r: RequestState, p: PatchView, interdiff: string | undefined): Html | null {
  const comments = p.review?.comments ?? [];
  const drafts = new Map(p.replyDrafts.map((d) => [d.commentId, d.text]));
  // Thanks, apologies: nothing to answer.
  const shown = comments.filter((c) => c.author !== p.review?.author && c.kind !== "none" && (!c.done || drafts.has(c.id)) && !isAnswered(p, c));
  // An empty interdiff (from before they stopped being recorded): nothing changed.
  const changed = p.interdiffFile !== undefined && interdiff?.trim() !== "";
  if (!changed && !shown.length) {
    return null;
  }
  const revision = p.review?.revision ?? p.revision;
  // Where each comment's answer stands: its draft reply is the answer; without one, the code is (its run's summary,
  // about all the comments it was given, on hover).
  const answer = (id: number): Html | null => {
    const job = Object.values(r.jobs).findLast((j) => j.purpose?.patch === p.id && j.purpose.comments?.includes(id));
    if (!job) return html`<div class="answer sub">not answered yet</div>`;
    if (job.endedAt === undefined) return html`<div class="answer"><span class="working">being answered by its author</span></div>`;
    if (drafts.has(id)) return null;
    if (job.exitCode !== 0) return html`<div class="answer sub">${job.error ?? "its author's run failed"}</div>`;
    return html`<div class="answer sub" title="${job.said ?? job.outcome ?? ""}">handled in the code, no reply</div>`;
  };
  // Each comment a thread under one bar: the comment, its author's answer, the reply to post.
  return html`${!changed ? null : html`<h4 class="part">Interdiff</h4>${interdiff === undefined ? html`<div class="sub">${p.interdiffFile} can't be read</div>` : diff(interdiff)}`}${
    shown.length ? html`<h4 class="part">Review comments</h4>` : null
  }${shown.map((c) => {
    const draft = drafts.get(c.id);
    return html`<div class="thread" data-comment="${c.id}"><div class="comment"><b>${c.author}</b>${c.file ? html` <span class="sub mono">${c.file}${c.line ? `:${c.line}` : ""}</span>` : null}${c.kind ? html` <span class="sub">(${c.kind})</span>` : null}: ${c.text}${
      c.suggestion ? html`<pre class="diff">${c.suggestion}</pre>` : null
    }</div>${c.author === p.review?.author ? null : answer(c.id)}${
      draft !== undefined
        ? html`<div class="draftreply"><div class="parthead"><b>Draft reply</b>${copyButton(`reply-${p.id}-${c.id}`, "Copy reply", true)}${
            revision ? html`<a class="btn small" href="${phabUrl(revision, c.id)}" target="_blank" rel="noopener" title="D${revision}#inline-${c.id}">Open comment ↗</a>` : null
          }</div><textarea rows="${replyRows(draft)}" id="reply-${p.id}-${c.id}">${draft}</textarea></div>`
        : null
    }</div>`;
  })}`;
}

// Tall enough to read it whole, wrapped at about 110 characters, up to 8 lines.
function replyRows(text: string): number {
  return Math.min(8, text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 110)), 0));
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


// The latest critical review's findings when no run of its author took them up (nits once it's submitted): yours to
// take or leave, rather than gone unseen.
function leftFindings(r: RequestState, p: PatchView, ctx: RenderContext): Html | null {
  // Landed or abandoned: too late for them.
  if (p.review?.status === "published" || p.review?.status === "abandoned") return null;
  const review = Object.values(r.jobs).findLast((j) => j.name === "review-patch" && j.purpose?.patch === p.id && j.exitCode === 0);
  if (!review || Object.values(r.jobs).some((j) => j.item === p.item && j.purpose?.key.startsWith("author:") && j.startedAt > review.startedAt)) return null;
  const text = ctx.readData?.(`requests/${r.id}/reports/${review.job}.json`);
  const report = text === undefined ? undefined : (JSON.parse(text) as ReviewPatchReport);
  if (report?.verdict !== "findings") return null;
  const line = (f: ReviewPatchReport["findings"][number]) => `${f.severity}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}: ${f.text}`;
  const message = `A critical reviewer left these on your patch; address them by amending your commit, or say in one line why not:\n${report.findings.map((f) => `- ${line(f)}`).join("\n")}`;
  const item = p.item ? r.items[p.item] : undefined;
  const send = item && talkBox(r, item, ctx, p) ? html`<form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "comment-fix", request: r.id, patch: p.id, text: message }], requestUrl(r.id))}<button class="btn small" title="Resumes its author's session with these findings; its patch then goes through lint and critical review again">Send to its author</button></form>` : null;
  return html`<h4 class="part">Critical review (Opus): not sent to its author${send}</h4><ul class="findings">${report.findings.map(
    (f) => html`<li><span class="sub">${f.severity}${f.file ? html` · <span class="mono">${f.file}${f.line ? `:${f.line}` : ""}</span>` : null}</span> ${f.text}</li>`,
  )}</ul>`;
}

// Once Lando took the push: what it waits for, with its Treeherder link.
function landoState(job: JobView, ctx: RenderContext, submitted: Html | string, before: Html | string): Html | string {
  const url = ctx.landoUrl?.(job);
  return url ? html`${submitted} · <a href="${url}" target="_blank" rel="noopener">Treeherder ↗</a>` : before;
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
    tip: p.rev
      ? { ok: "Green on try", bad: "Failures on try", run: "Running on try" }[pushResultClass(p)]
      : waiting
        ? "Waiting for your approval"
        : job && job.exitCode !== 0 && job.endedAt
          ? "Not pushed: see its ⚑"
          : p.declined === undefined
            ? "Being pushed"
            : "Declined or withdrawn",
    // What it's for in a few words; its planner's full purpose in its title and body.
    name: html`push ${pushName(r, p.id)}: ${p.title ?? p.purpose}`,
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
                ? landoState(job, ctx, html`submitted, waiting for Lando to land it (${elapsed(job.startedAt, ctx)})`, html`approved, pushing for ${elapsed(job.startedAt, ctx)}`)
                : job.exitCode === 0
                  ? landoState(job, ctx, "submitted, waiting for Lando to land it", "pushed, waiting for its revision")
                  : "approved, not pushed: see its ⚑ above"
    }`,
    trust: revisedText(r, p),
    warn: waiting ? dryRunWarnings(r, p) : null,
    // While it waits for you, what it would run; once made, what came of it, its jobs and command folded under it.
    // While it waits for you, what it would run is in sight once opened, without a fetch.
    ...(waiting ? {} : { lazy: { r, ctx } }),
    body: () => html`${sinceSection(r, p, ctx)}${waiting ? null : pushAnalysis(r, p)}${
      waiting ? pushJobs(p) : html`<details class="fold" data-fold="pushjobs-${p.id}"><summary>Its jobs, commits and command</summary>${pushJobs(p)}</details>`
    }${revisable(r, p) ? reviseBox(r, p) : null}`,
  });
}

// A push planned again after your comment: what you said, and what its planner answered (its revision run's answer).
function revisedText(r: RequestState, p: PushView): Html | null {
  if (!p.revises?.length) return null;
  const said = p.revises.map((id) => r.pushes[id]?.declined).filter((x) => x !== undefined);
  const job = Object.values(r.jobs).findLast((j) => j.purpose?.what === "plan-pushes" && j.purpose.pushes?.join() === p.revises!.join());
  const yours = p.revises.every((id) => !r.pushes[id]?.withdrawn);
  return html`${yours ? "revised after you said" : "revised after"} <span class="said">“${said.join("”, “")}”</span>${job?.outcome ? html` · <b>its planner:</b> ${job.outcome}` : null}`;
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
  // Those nothing fixes first: this push won't fix them; each with a box to tell the author of the patch that broke it.
  const link = (id: string) => html`<a href="#patch-${id}">${title(id)}</a>`;
  const statusOf = (g: Regression) => regressionStatus(r, g);
  const tell = (g: Regression) => {
    const item = g.causedBy ? r.patches[g.causedBy]?.item : undefined;
    return item === undefined
      ? null
      : html`<form class="cmd inline-tell" method="post" action="/api/commands">${commandFields([{ cmd: "continue", request: r.id, item }], requestUrl(r.id))}<input type="text" name="text" required value="${`The stack's last try push still has this regression from your patch, and nothing since fixes it: ${g.failure} Fix it, or show it fails the same way on central.`}"><button class="btn small">Tell its author</button></form>`;
  };
  const regression = (g: Regression) =>
    html`<li><div class="clamp1" data-expand title="Click to see all of it">${md(g.failure)}</div><div class="sub clamp1" data-expand title="Click to see all of it">${g.causedBy ? html`broken by ${link(g.causedBy)} · ` : null}${g.fixedBy ? html`fixed by ${link(g.fixedBy)}: ` : null}${g.how}</div>${statusOf(g) === "not fixed" ? tell(g) : null}</li>`;
  const STATUSES: [string, string][] = [["not fixed", "not fixed yet"], ["fixed", "fixed since"], ["patch removed", "gone with the patch that caused it"], ["pre-existing", "fails the same way on central"]];
  const regressions = p.regressions?.length
    ? html`<h4 class="part">The regressions of push ${pushName(r, since)}</h4>${STATUSES.map(([st, label]) => {
        const these = p.regressions!.filter((g) => statusOf(g) === st);
        return these.length ? html`<h5 class="verdict">${label} <span class="count">${these.length}</span>${st === "not fixed" ? html`: this push won't fix them` : null}</h5><ul class="regressions">${these.map(regression)}</ul>` : null;
      })}`
    : null;
  const changed = changes?.changes.filter((c) => c.status !== "same") ?? [];
  const list = changes
    ? html`<h4 class="part">Changed since push ${pushName(r, since)}${prev?.rev ? html` (<a href="${pushUrl(prev)}" target="_blank" rel="noopener">${(prev.summary ?? prev.result ?? "").split(":")[0]}</a>)` : null}</h4>${
        changed.length === 0 && changes.removed.length === 0
          ? html`<div class="sub">Nothing: the same patches.</div>`
          : html`<ul class="changes">${firstTwo(`since-changed-${p.id}`, changed.map((c) => {
              const text = c.interdiffFile ? ctx.readData?.(c.interdiffFile) : undefined;
              const said = authorSaid(r, c.patch);
              return html`<li><b>${c.status === "new" ? "new" : "changed"}</b>: <a href="#patch-${c.patch}">${title(c.patch)}</a>${said ? html`<div class="sub clamp1" title="${said}">${said}</div>` : null}${
                text === undefined ? null : html`<details class="fold" data-fold="since-${p.id}-${c.patch}"><summary>Interdiff</summary>${diff(text)}</details>`
              }</li>`;
            }))}${firstTwo(`since-gone-${p.id}`, changes.removed.map((x) => html`<li><b>gone</b>: ${x.title}</li>`))}</ul>`
      }`
    : null;
  return html`${regressions}${list}`;
}

// Its landing backed out: whether it caused it, and what it waits for.
function backoutText(r: RequestState, p: PatchView): Html | null {
  const b = r.backouts[p.id];
  if (!b || p.review?.status === "published") return null;
  const why = b.reason.split("\n")[0];
  const state = !b.culprit ? "backed out with another patch: it can land again" : b.verified ? "backed out, its fix green on try: it can land again" : "backed out: its fix needs a green try run first";
  return html`<span class="bad" title="${why}">${state}</span>`;
}

// A list's first two items, the rest folded under "+n more".
function firstTwo(fold: string, items: Html[]): Html {
  return html`${items.slice(0, 2)}${items.length > 2 ? html`<li class="more"><details class="fold" data-fold="${fold}"><summary>+${items.length - 2} more</summary><ul class="changes">${items.slice(2)}</ul></details></li>` : null}`;
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
  // One row per test (its configs and patches together), by verdict, what needs attention first; long lists folded
  // after 5. Triage names a test by its path or its file name, sometimes with a note, and a config by a job name or
  // a list: grouped by file name, the longest name shown.
  const testKey = (t: string) => t.replace(/\s*\([^)]*\)/g, "").trim().split("/").pop()!;
  const configsOf = (c: string | undefined) => (c ?? "").split(/[;,]\s*/).map((x) => x.trim().replace(/^test-/, "")).filter(Boolean);
  const patchOf = (ref: string) => r.patches[ref] ?? Object.values(r.patches).find((x) => [x.sha, ...(x.pastShas ?? [])].some((s) => s.startsWith(ref) || ref.startsWith(s)));
  const groups = new Map<string, { verdict: string; test: string; patches: Html[]; seen: Set<string>; configs: string[]; evidence: string; pids: string[] }>();
  for (const c of p.analysis) {
    const test = c.test ? relativeTest(r, c.test) : (c.taskId ?? "a job");
    const key = `${c.verdict}\n${testKey(test)}`;
    const g = groups.get(key) ?? { verdict: c.verdict, test, patches: [], seen: new Set<string>(), configs: [], evidence: c.evidence, pids: [] };
    if (test.replace(/\s*\([^)]*\)/g, "").length > g.test.length) g.test = test.replace(/\s*\([^)]*\)/g, "").trim();
    for (const x of configsOf(c.config)) if (!g.configs.includes(x)) g.configs.push(x);
    if (c.patch) {
      const pv = patchOf(c.patch);
      const id = pv?.id ?? c.patch;
      if (!g.seen.has(id)) {
        g.seen.add(id);
        if (pv) g.pids.push(pv.id);
        g.patches.push(pv ? html`<a href="#patch-${pv.id}">${patchTitle(pv)}</a>` : html`<span class="mono">${c.patch.slice(0, 12)}</span>`);
      }
    }
    g.evidence = c.evidence; // the latest triage's
    groups.set(key, g);
  }
  // What came of a failure pinned on a patch: its author's run for this push, or why there's none.
  const next = (g: { verdict: string; pids: string[] }): Html | null => {
    if (g.verdict !== "broken by patch") return null;
    return join(
      g.pids.map((pid) => {
        const item = r.patches[pid]?.item;
        const job = Object.values(r.jobs).findLast((j) => j.item === item && j.purpose?.reason === "try" && j.purpose.key.includes(`:try:${p.id}`));
        const t = r.tryNeeded?.[pid];
        if (item && r.followUps?.includes(`${p.id} ${item}`)) return html`left as a follow-up by you: it doesn't hold its patch back`;
        // Not worth a fix now (a test too slow in chaos mode…): it neither goes to its author nor holds its patch back.
        const followUp = html` <form class="inline cmd" method="post" action="/api/commands">${commandFields([{ cmd: "follow-up", request: r.id, push: p.id, patch: pid }], requestUrl(r.id))}<button class="btn small" title="It doesn't go to its author and doesn't keep its patch from landing">Leave as a follow-up</button></form>`;
        if (!job) return html`not sent to its author${t && !t.verified ? ": its newer fix wasn't in this push, and goes to try in a push of its own" : ""}${followUp}`;
        if (job.endedAt === undefined) return html`<span class="working">its author is looking at it</span>`;
        const said = job.said ?? job.outcome;
        return html`its author: ${said ?? job.error ?? "no answer"}${followUp}`;
      }),
      " · ",
    );
  };
  const li = (g: { verdict: string; test: string; patches: Html[]; configs: string[]; evidence: string; pids: string[] }) =>
    html`<li>${g.test}${g.configs.length ? html` <span class="sub">on ${g.configs.join(", ")}</span>` : null}${g.patches.length ? html` <span class="sub">· ${join(g.patches, ", ")}</span>` : null}<div class="sub clamp1" data-expand title="Click to see all of it">${g.evidence}</div>${
      next(g) ? html`<div class="next">→ ${next(g)}</div>` : null
    }</li>`;
  const all = [...groups.values()];
  return html`<h4 class="part">What the factory made of its failures</h4>${VERDICT_ORDER.filter((v) => all.some((g) => g.verdict === v)).map((v) => {
    const these = all.filter((g) => g.verdict === v);
    return html`<h5 class="verdict">${v} <span class="count">${plural(these.length, "test")}</span></h5><ul class="analysis">${these.slice(0, 5).map(li)}</ul>${
      these.length > 5 ? html`<details class="fold" data-fold="analysis-${p.id}-${v}"><summary>+${these.length - 5} more</summary><ul class="analysis">${these.slice(5).map(li)}</ul></details>` : null
    }`;
  })}`;
}

const VERDICT_ORDER = ["broken by patch", "still failing", "fixed", "infra", "pre-existing"];

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
  return html`<form class="cmd revise joined" method="post" action="/api/commands">${commandFields([{ cmd: "revise-push", request: r.id, push: p.id }], requestUrl(r.id))}<textarea name="text" required rows="2" placeholder="What should it run instead? The agent that planned it gets this; the plan's other pushes stay as they are">${declined}</textarea><button class="btn small" title="Enter sends; Shift+Enter for a new line">Send</button></form>`;
}
