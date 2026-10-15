import type { BugDraft, InvestigateReport, ItemView, JobView, PatchView, PushView, RequestState, StackView } from "../../types.ts";
import { ITEM_STATES } from "../commands.ts";
import { html, join, type Html } from "../html.ts";
import { actionsSummary, approvePushControls, bugBox, commandDetails, copyButton, recoveryPlan, recoveryPlanFor, stackViewerLink, summaryId, youSaid } from "./actions.ts";
import {
  bugUrl,
  commandFields,
  enterBugUrl,
  formatCost,
  formatDate,
  elapsed,
  formatDuration,
  groupLabel,
  hasBug,
  isDropped,
  isLandable,
  isLanded,
  itemOf,
  jobLabel,
  modelLabel,
  patchesOutsideStacks,
  patchTitle,
  phabUrl,
  PHAB_ICON,
  plural,
  profileUrl,
  requestCost,
  requestName,
  requestUrl,
  routeOutcome,
  sectionOf,
  stackPatches,
  stateClass,
  stepLabel,
  pushResultClass,
  pushStatus,
  pushUrl,
  type RenderContext,

} from "./common.ts";

// One line per request; the body only when expanded, so the overview stays small.
export function renderRequest(r: RequestState, ctx: RenderContext, open = ctx.open === r.id): Html {
  const needs = r.needsUser.length > 0;
  const cost = requestCost(r);
  return html`<details class="req${needs ? " needs" : ""}" id="req-${r.id}" data-request="${r.id}" data-section="${sectionOf(r)}"${open ? html` open` : null}>
    <summary>
      <span class="rname">${requestName(r)}</span>
      <span class="rsum">${requestSummary(r)}</span>
      ${requestWork(r, ctx)}
      <span class="rright">${cost > 0 ? html`<span class="hide-sm" title="Agent cost so far">${formatCost(cost)}</span>` : null}<span class="step">${stepLabel(r)}</span><a class="btn small" href="${profileUrl(ctx, r.id)}" target="_blank" rel="noopener">Profile</a></span>
      ${actionsSummary(r)}
    </summary>
    ${open ? renderRequestBody(r, ctx) : html`<div class="rbody" data-lazy><a href="${requestUrl(r.id)}">Open this request</a></div>`}
  </details>`;
}

export function requestSummary(r: RequestState): string {
  const parts: string[] = [];
  if (r.kind === "unrouted") {
    parts.push(r.step === "done" ? routeOutcome(r) : "not routed yet: a new request, or about an existing one?");
  } else if (r.step === "request") {
    const keys = configEntries(r).map(([k]) => k);
    parts.push(keys.length ? `config: ${keys.join(", ")}` : "turning the request into a config");
  }
  const items = Object.values(r.items);
  if (items.length) {
    const byState = ITEM_STATES.map((s) => [s, items.filter((i) => i.state === s).length] as const).filter(([, n]) => n > 0);
    parts.push(`${plural(items.length, "failure group")}: ${byState.map(([s, n]) => `${n} ${s}`).join(", ")}`);
  }
  const patches = Object.values(r.patches).filter((p) => !isDropped(r, p));
  if (patches.length) {
    const accepted = patches.filter((p) => p.review?.status === "accepted" || (p.review && p.review.reviewers.length > 0 && p.review.reviewers.every((x) => x.status === "accepted"))).length;
    const toFile = patches.filter((p) => !hasBug(p) && p.bugDraft).length;
    parts.push(
      [plural(patches.length, "patch", "patches"), accepted ? `${accepted} accepted` : "", toFile ? `${plural(toFile, "bug")} to file` : ""].filter(Boolean).join(", "),
    );
  }
  const pushes = Object.values(r.pushes);
  const last = pushes.at(-1);
  if (last) {
    parts.push(`try: ${pushStatus(last)}`);
  }
  return parts.join(" · ");
}

// Jobs without an item (recover, route-request, plan-try-pushes, try watch…) have no group row
// to show them while they run.
function requestWork(r: RequestState, ctx: RenderContext): Html | null {
  const running = Object.values(r.jobs).filter((j) => j.item === undefined && j.endedAt === undefined);
  if (!running.length) {
    return null;
  }
  return html`<div class="rwork">${running.map(
    (j) => html`<div title="${j.name}"><span class="st run">${jobLabel(j.name)}</span>${j.model ? ` · ${modelLabel(j.model)}` : null} · ${elapsed(j.startedAt, ctx)}</div>`,
  )}</div>`;
}

export function renderRequestBody(r: RequestState, ctx: RenderContext): Html {
  const back = requestUrl(r.id);
  const stacks = Object.values(r.stacks);
  const loose = patchesOutsideStacks(r);
  const stackedItems = new Set(stacks.flatMap((s) => stackPatches(r, s).map((p) => p.item)));
  const items = Object.values(r.items).filter((i) => !stackedItems.has(i.id));
  const pushes = Object.values(r.pushes);
  const planned = pushes.filter((p) => !p.rev);
  const sent = pushes.filter((p) => p.rev);
  const shownPlans = new Set(r.needsUser.map((n) => recoveryPlanFor(r, n)));
  const plans = r.recoveryPlans.filter((p) => !shownPlans.has(p));

  return html`<div class="rbody">
    ${requestWork(r, ctx)}
    ${configLine(r)}
    ${r.metaBug ? metaBugLine(r, back) : null}
    ${stacks.map((s) => stackSection(r, s, ctx))}
    ${loose.length ? html`${loose.some((p) => !isDropped(r, p)) ? html`<h3>Patches</h3>` : null}${patchTable(r, loose, ctx, "loose")}` : null}
    ${items.length ? html`<h3>${stacks.length ? "Other groups" : "Failure groups"}</h3>${groupTable(r, items, ctx)}` : null}
    ${planned.length ? html`<h3>Try plan <span class="sub">· waiting for your approval</span></h3><table><tbody>${planned.map((p) => html`<tr><td class="res plan">push ${p.id}</td><td>${p.purpose}${p.taskCount === undefined ? null : html` · ${p.taskCount} tasks`}</td><td>${commandDetails(p)}</td></tr>`)}</tbody></table><div style="margin-top:6px">${approvePushControls(r, planned, back)}</div>` : null}
    ${sent.length ? html`<h3>Try pushes</h3><table><tbody>${sent.map(pushRow)}</tbody></table>` : null}
    ${plans.length ? html`<details style="margin-top:10px"><summary class="sub">Earlier recovery plans (${plans.length})</summary>${plans.map((p) => html`<div class="action"><span class="flag">Recovery plan</span> ${youSaid(`You said: “${p.text}”`)}${recoveryPlan(r, p, back)}</div>`)}</details>` : null}
    ${recentJobs(r, ctx)}
    ${r.notes.length ? html`<h3>Notes</h3>${r.notes.slice(-5).map((n) => html`<div class="sub">${formatDate(n.t)} · ${n.text}</div>`)}` : null}
    <form class="ask cmd" style="margin-top:10px" method="post" action="/api/commands">${commandFields([{ cmd: "tell-factory", request: r.id }], back)}<input type="text" name="text" required placeholder="Tell the factory about this request…"><button class="btn">Send</button></form>
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

function configLine(r: RequestState): Html | null {
  const entries = configEntries(r);
  if (!entries.length) {
    return null;
  }
  return html`<h3>Config <span class="sub">· from your request</span></h3><div class="sub">${join(
    entries.map(([k, v]) => html`<b>${k}</b>: ${v}`),
    " · ",
  )}</div>`;
}

function metaBugLine(r: RequestState, back: string): Html {
  const m = r.metaBug!;
  if (hasBug(m)) {
    return html`<div class="sub" style="margin-top:8px">Meta bug: <a class="bug" href="${bugUrl(m.bug)}">Bug ${m.bug}</a></div>`;
  }
  return html`<div class="box"><h4>Meta bug ${m.draft ? html`· <a class="bug tofile" href="${enterBugUrl(m.draft)}" target="_blank" rel="noopener">Bug to file</a> · “${m.draft.summary}”` : null}</h4>${
    m.draft ? html`<details><summary>Description</summary><div class="desc">${m.draft.description}</div></details>` : null
  }${bugBox(r.id, "meta", back, "row")}</div>`;
}

function stackSection(r: RequestState, s: StackView, ctx: RenderContext): Html {
  const patches = stackPatches(r, s);
  return html`<h3>${s.folder} <span class="sub">· stack order: easy and valuable first, each patch after its hard deps · <span class="mono">${s.branch}</span></span></h3>
    ${patchTable(r, patches, ctx, `stack-${s.id}`)}
    ${
      s.summary
        ? html`<details style="margin-top:6px"><summary class="sub">Meta-bug comment</summary><textarea readonly rows="6" id="${summaryId(r.id, s.id)}-body">${s.summary}</textarea></details>`
        : null
    }
    <div style="margin-top:8px">${stackViewerLink(s)}${s.summary ? html` ${copyButton(`${summaryId(r.id, s.id)}-body`, "Copy the meta-bug comment")}` : null}</div>`;
}

interface PatchColumns {
  effort: boolean;
  value: boolean;
  reviewers: boolean;
}

// fold: names the Dropped line, so that it stays open across updates.
function patchTable(r: RequestState, patches: PatchView[], ctx: RenderContext, fold: string): Html {
  const dropped = patches.filter((p) => isDropped(r, p));
  const live = patches.filter((p) => !isDropped(r, p));
  // Landed patches only matter as history once the rest is in review.
  const landed = live.filter((p) => isLanded(r, p));
  const rest = landed.length < live.length ? live.filter((p) => !isLanded(r, p)) : live;
  const folded = rest === live ? [] : landed;
  const columns: PatchColumns = {
    effort: live.some((p) => p.effort !== undefined),
    value: live.some((p) => itemOf(r, p)?.group.ratePerWeek !== undefined),
    reviewers: live.some((p) => p.review),
  };
  const span = 2 + Object.values(columns).filter(Boolean).length;
  return html`${
    live.length
      ? html`<div class="scroll"><table>
    <thead><tr><th>Patch</th><th>State</th>${columns.effort ? html`<th class="hide-sm" title="Expected review effort, 1 = trivial">Effort</th>` : null}${
      columns.value ? html`<th class="num hide-sm" title="Failures per week fixed">Value</th>` : null
    }${columns.reviewers ? html`<th>Reviewers</th>` : null}</tr></thead>
    <tbody>${rest.map((p) => patchRow(r, p, columns, ctx))}${
      folded.length ? html`<tr><td colspan="${span}" class="sub"><details data-fold="landed-${fold}"><summary>${folded.length} landed ▸</summary>${folded.map((p) => patchLine(p))}</details></td></tr>` : null
    }</tbody>
  </table></div>`
      : null
  }${
    dropped.length
      ? html`<details class="fold" data-fold="dropped-${fold}"><summary>Dropped (${dropped.length})</summary>${dropped.map((p) => patchLine(p, itemOf(r, p)!.state))}</details>`
      : null
  }`;
}

function patchLine(p: PatchView, state?: string): Html {
  return html`<div class="sub">${p.revision ? html`<a href="${phabUrl(p.revision)}" target="_blank" rel="noopener">D${p.revision}</a> ` : null}${bugLabel(p)} ${patchTitle(p)}${
    state ? ` (${state})` : null
  }</div>`;
}

function patchRow(r: RequestState, p: PatchView, columns: PatchColumns, ctx: RenderContext): Html {
  const back = requestUrl(r.id);
  const item = itemOf(r, p);
  const rate = item?.group.ratePerWeek;
  return html`<tr data-patch="${p.id}">
    <td>${p.revision ? html`<a class="phab" href="${phabUrl(p.revision)}" title="D${p.revision}" target="_blank" rel="noopener">${PHAB_ICON}</a>` : null}${bugLabel(p)} ${patchTitle(p)}${
      !hasBug(p) && !p.bugDraft && p.testOnly ? html` <span class="sub">(meta bug)</span>` : null
    }
      ${!hasBug(p) && p.bugDraft ? bugDraftBox(r.id, p, back) : null}
      ${p.deps.map((d) => depLine(r, d))}
      ${reviewBox(r, p, back, p.interdiffFile === undefined ? undefined : ctx.interdiff?.(p))}
    </td>
    <td>${item ? html`<span class="st ${stateClass(item.state)}">${item.state}</span>` : null}</td>
    ${columns.effort ? html`<td class="hide-sm">${p.effort ?? ""}</td>` : null}
    ${columns.value ? html`<td class="num hide-sm">${rate === undefined ? "" : `${rate}/wk`}</td>` : null}
    ${columns.reviewers ? html`<td>${reviewers(r, p)}</td>` : null}
  </tr>`;
}

function bugLabel(p: PatchView): Html {
  if (hasBug(p)) {
    return html`<a class="bug" href="${bugUrl(p.bug)}" target="_blank" rel="noopener">Bug ${p.bug}</a>`;
  }
  if (p.bugDraft) {
    return html`<a class="bug tofile" href="${enterBugUrl(p.bugDraft)}" target="_blank" rel="noopener" title="Opens a prefilled enter_bug.cgi">Bug to file</a>`;
  }
  return html`<span class="bug none">no bug yet</span>`;
}

function bugDraftBox(request: string, p: PatchView, back: string): Html {
  const d = p.bugDraft!;
  return html`<div class="box">
    <h4>Bug draft · ${d.product}::${d.component} · “${d.summary}”</h4>
    <details><summary>Description</summary><div class="desc">${d.description}</div></details>
    ${bugBox(request, p.id, back, "row")}
  </div>`;
}

function depLine(r: RequestState, d: PatchView["deps"][number]): Html {
  const needed = r.patches[d.needs];
  const label = needed ? `“${patchTitle(needed)}”${needed.revision ? ` (D${needed.revision})` : ""}` : d.needs;
  const met = needed !== undefined && itemOf(r, needed)?.state === "landed";
  return html`<div class="dep${met ? " met" : ""}">${d.kind === "hard" ? "⛔ hard" : "🔗 soft"}: needs ${label} (${d.reason})</div>`;
}

function reviewers(r: RequestState, p: PatchView): Html | null {
  if (!p.review) {
    return null;
  }
  const cls = { accepted: "ok", blocking: "block", pending: "pend", resigned: "pend" } as const;
  return html`${p.review.reviewers.map((x) => html`<span class="rv ${cls[x.status]}"${x.status === "resigned" ? html` title="resigned"` : null}>${x.name}</span>`)}${
    isLandable(r, p) ? html`<span class="landable">landable</span>` : null
  }<div class="sub">${p.review.status}</div>`;
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

function runningJob(r: RequestState, i: ItemView): JobView | undefined {
  return i.jobs.map((j) => r.jobs[j]).findLast((j) => j.endedAt === undefined);
}

// What runs or waits for you first, then the rest; the closed ones folded under one line.
function groupTable(r: RequestState, items: ItemView[], ctx: RenderContext): Html {
  const closed = items.filter((i) => stateClass(i.state) === "closed");
  const open = items.filter((i) => stateClass(i.state) !== "closed");
  const busy = (i: ItemView) => runningJob(r, i) !== undefined || stateClass(i.state) === "run" || r.needsUser.some((n) => n.item === i.id);
  const notStarted = (i: ItemView) => i.state === "not started";
  const sorted = [...open.filter(busy), ...open.filter((i) => !busy(i) && !notStarted(i)), ...open.filter((i) => !busy(i) && notStarted(i))];
  // A bug to file stays in sight, even for a closed group.
  const withDraft = closed.filter((i) => itemBugDraft(r, i));
  const folded = closed.filter((i) => !itemBugDraft(r, i));
  const states = new Set(folded.map((i) => i.state));
  const closedLabel = `${folded.length} ${states.size === 1 ? folded[0].state : "closed"}`;
  return html`<table class="groups"><tbody>${[...sorted, ...withDraft].map((i) => itemRow(r, i, ctx))}${
    folded.length
      ? html`<tr><td colspan="2" class="foldrow"><details class="fold" data-fold="closed-groups"><summary>${closedLabel}</summary><table class="groups"><tbody>${folded.map((i) =>
          itemRow(r, i, ctx),
        )}</tbody></table></details></td></tr>`
      : null
  }</tbody></table>`;
}

function itemRow(r: RequestState, i: ItemView, ctx: RenderContext): Html {
  const job = runningJob(r, i);
  const draft = itemBugDraft(r, i);
  const tests = i.group.tests;
  const cost = i.jobs.reduce((sum, j) => sum + (r.jobs[j].costUsd ?? 0), 0);
  const work = job
    ? html`<span class="sub"> · ${job.kind === "agent" && job.model ? modelLabel(job.model) : jobLabel(job.name)} · ${elapsed(job.startedAt, ctx)}${
        cost > 0 ? html` · <span title="Agent cost of this group so far">${formatCost(cost)}</span>` : null
      }</span>`
    : null;
  // A job running for a group not started yet (its worktree build) means it has started.
  const preparing = job !== undefined && i.state === "not started";
  const state = html`<span class="st ${preparing ? "run" : stateClass(i.state)}">${preparing ? "preparing" : i.state}</span>${work}${i.detail ? html`<span class="detail">: ${i.detail}</span>` : null}`;
  return html`<tr data-item="${i.id}">
    <td class="gname"><span title="${[...tests, i.group.configs.join(", ")].join("\n")}">${groupLabel(r, i)}</span><div class="sub clamp2" title="${i.group.message}">${i.group.message}</div></td>
    <td>${
      i.detail
        ? html`<details class="clamp3" data-fold="detail-${i.id}" title="${i.state}: ${i.detail}"><summary>${state}</summary></details>`
        : state
    }${draft ? html`<div><a class="bug tofile" href="${enterBugUrl(draft)}" target="_blank" rel="noopener" title="Opens a prefilled enter_bug.cgi">Bug to file</a> <span class="sub">“${draft.summary}”</span></div>` : null}</td>
  </tr>`;
}

// A bug the investigation asks to file without a patch to carry it (e.g. a product bug behind a
// group left as-is); a patch's draft shows on its patch row instead.
function itemBugDraft(r: RequestState, i: ItemView): BugDraft | undefined {
  if (i.lastReport?.prompt !== "investigate-and-fix" || Object.values(r.patches).some((p) => p.item === i.id)) {
    return undefined;
  }
  return (i.lastReport.report as InvestigateReport).bugDraft;
}

function pushRow(p: PushView): Html {
  return html`<tr><td class="mono"><a href="${pushUrl(p)}" target="_blank" rel="noopener">${p.rev!.slice(0, 12)}</a></td><td>${p.purpose}</td><td class="res ${pushResultClass(p)}">${pushStatus(p)}</td></tr>`;
}

function recentJobs(r: RequestState, ctx: RenderContext): Html | null {
  const jobs = Object.values(r.jobs)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 8);
  if (!jobs.length) {
    return null;
  }
  // Collapsed: the group rows already show what runs.
  return html`<details class="fold section" data-fold="jobs"><summary>Recent jobs</summary><div class="scroll"><table><tbody>${jobs.map(
    (j) =>
      html`<tr${j.error ? html` title="${j.error}"` : null}><td><span title="${j.name}">${jobLabel(j.name)}</span> ${
        // The folded state keeps jobs whose item it doesn't know.
        j.item === undefined ? null : html`<span class="sub" title="${j.item}">${j.item in r.items ? groupLabel(r, r.items[j.item]) : j.item}</span>`
      }</td><td class="sub">${j.kind}${j.model ? ` · ${modelLabel(j.model)}` : ""}</td><td class="res ${
        j.endedAt === undefined ? "run" : j.exitCode === 0 ? "ok" : "bad"
      }">${j.endedAt === undefined ? html`running ${elapsed(j.startedAt, ctx)}` : `${formatDuration(j.durationMs ?? Date.parse(j.endedAt) - Date.parse(j.startedAt))}${j.exitCode ? `, exit ${j.exitCode}` : ""}`}</td><td class="num sub">${
        j.costUsd === undefined ? "" : formatCost(j.costUsd)
      }</td></tr>`,
  )}</tbody></table></div></details>`;
}
