import type { ItemView, PatchView, PushView, RequestState, StackView } from "../../types.ts";
import { ITEM_STATES } from "../commands.ts";
import { html, join, type Html } from "../html.ts";
import { actionsSummary, approvePushControls, bugBox, commandDetails, copyButton, recoveryPlan, recoveryPlanFor, stackViewerLink, summaryId } from "./actions.ts";
import {
  bugUrl,
  commandFields,
  enterBugUrl,
  formatCost,
  formatDate,
  elapsed,
  formatDuration,
  isLandable,
  isLanded,
  itemOf,
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
    const keys = Object.keys(r.config);
    parts.push(keys.length ? `config: ${keys.join(", ")}` : "turning the request into a config");
  }
  const items = Object.values(r.items);
  if (items.length) {
    const byState = ITEM_STATES.map((s) => [s, items.filter((i) => i.state === s).length] as const).filter(([, n]) => n > 0);
    parts.push(`${plural(items.length, "failure group")}: ${byState.map(([s, n]) => `${n} ${s}`).join(", ")}`);
  }
  const patches = Object.values(r.patches);
  if (patches.length) {
    const accepted = patches.filter((p) => p.review?.status === "accepted" || (p.review && p.review.reviewers.length > 0 && p.review.reviewers.every((x) => x.status === "accepted"))).length;
    const toFile = patches.filter((p) => p.bug === null && p.bugDraft).length;
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
    ${configLine(r)}
    ${r.metaBug ? metaBugLine(r, back) : null}
    ${stacks.map((s) => stackSection(r, s, ctx))}
    ${loose.length ? html`<h3>Patches</h3>${patchTable(r, loose, ctx)}` : null}
    ${items.length ? html`<h3>${stacks.length ? "Other groups" : "Failure groups"}</h3><div class="scroll"><table><tbody>${items.map((i) => itemRow(r, i, ctx))}</tbody></table></div>` : null}
    ${planned.length ? html`<h3>Try plan <span class="sub">· waiting for your approval</span></h3><table><tbody>${planned.map((p) => html`<tr><td class="res plan">push ${p.id}</td><td>${p.purpose}${p.taskCount === undefined ? null : html` · ${p.taskCount} tasks`}</td><td>${commandDetails(p)}</td></tr>`)}</tbody></table><div style="margin-top:6px">${approvePushControls(r, planned, back)}</div>` : null}
    ${sent.length ? html`<h3>Try pushes</h3><table><tbody>${sent.map(pushRow)}</tbody></table>` : null}
    ${plans.length ? html`<details style="margin-top:10px"><summary class="sub">Earlier recovery plans (${plans.length})</summary>${plans.map((p) => html`<div class="action"><span class="flag">Recovery plan</span><span class="why">You said: “${p.text}”</span>${recoveryPlan(r, p, back)}</div>`)}</details>` : null}
    ${recentJobs(r, ctx)}
    ${r.notes.length ? html`<h3>Notes</h3>${r.notes.slice(-5).map((n) => html`<div class="sub">${formatDate(n.t)} · ${n.text}</div>`)}` : null}
    <form class="ask cmd" style="margin-top:10px" method="post" action="/api/commands">${commandFields([{ cmd: "tell-factory", request: r.id }], back)}<input type="text" name="text" required placeholder="Tell the factory about this request…"><button class="btn">Send</button></form>
  </div>`;
}

function configLine(r: RequestState): Html | null {
  const entries = Object.entries(r.config);
  if (!entries.length) {
    return null;
  }
  return html`<h3>Config <span class="sub">· from your request</span></h3><div class="sub">${join(
    entries.map(([k, v]) => html`<b>${k}</b>: ${typeof v === "string" ? v : JSON.stringify(v)}`),
    " · ",
  )}</div>`;
}

function metaBugLine(r: RequestState, back: string): Html {
  const m = r.metaBug!;
  if (m.bug !== null) {
    return html`<div class="sub" style="margin-top:8px">Meta bug: <a class="bug" href="${bugUrl(m.bug)}">Bug ${m.bug}</a></div>`;
  }
  return html`<div class="box"><h4>Meta bug ${m.draft ? html`· <a class="bug tofile" href="${enterBugUrl(m.draft)}" target="_blank" rel="noopener">Bug to file</a> · “${m.draft.summary}”` : null}</h4>${
    m.draft ? html`<details><summary>Description</summary><div class="desc">${m.draft.description}</div></details>` : null
  }${bugBox(r.id, "meta", back, "row")}</div>`;
}

function stackSection(r: RequestState, s: StackView, ctx: RenderContext): Html {
  const patches = stackPatches(r, s);
  return html`<h3>${s.folder} <span class="sub">· stack order: easy and valuable first, each patch after its hard deps · <span class="mono">${s.branch}</span></span></h3>
    ${patchTable(r, patches, ctx)}
    ${
      s.summary
        ? html`<details style="margin-top:6px"><summary class="sub">Meta-bug comment</summary><textarea readonly rows="6" id="${summaryId(r.id, s.id)}-body">${s.summary}</textarea></details>`
        : null
    }
    <div style="margin-top:8px">${stackViewerLink(s)}${s.summary ? html` ${copyButton(`${summaryId(r.id, s.id)}-body`, "Copy the meta-bug comment")}` : null}</div>`;
}

function patchTable(r: RequestState, patches: PatchView[], ctx: RenderContext): Html {
  const reviewed = patches.some((p) => p.review);
  // Landed patches only matter as history once the rest is in review.
  const landed = patches.filter((p) => isLanded(r, p));
  const rest = landed.length < patches.length ? patches.filter((p) => !isLanded(r, p)) : patches;
  const folded = rest === patches ? [] : landed;
  return html`<div class="scroll"><table>
    <thead><tr><th>Patch</th><th>State</th><th class="hide-sm" title="Expected review effort, 1 = trivial">Effort</th><th class="num hide-sm" title="Failures per week fixed">Value</th>${reviewed ? html`<th>Reviewers</th>` : null}</tr></thead>
    <tbody>${rest.map((p) => patchRow(r, p, reviewed, ctx))}${
      folded.length
        ? html`<tr><td colspan="${reviewed ? 5 : 4}" class="sub"><details><summary>${folded.length} landed ▸</summary>${folded.map(
            (p) => html`<div>${p.revision ? html`<a href="${phabUrl(p.revision)}" target="_blank" rel="noopener">D${p.revision}</a> ` : null}${bugLabel(p)} ${patchTitle(p)}</div>`,
          )}</details></td></tr>`
        : null
    }</tbody>
  </table></div>`;
}

function patchRow(r: RequestState, p: PatchView, reviewedColumn: boolean, ctx: RenderContext): Html {
  const back = requestUrl(r.id);
  const item = itemOf(r, p);
  const rate = item?.group.ratePerWeek;
  return html`<tr data-patch="${p.id}">
    <td>${p.revision ? html`<a class="phab" href="${phabUrl(p.revision)}" title="D${p.revision}" target="_blank" rel="noopener">${PHAB_ICON}</a>` : null}${bugLabel(p)} ${patchTitle(p)}${
      p.bug === null && !p.bugDraft && p.testOnly ? html` <span class="sub">(meta bug)</span>` : null
    }
      ${p.bug === null && p.bugDraft ? bugDraftBox(r.id, p, back) : null}
      ${p.deps.map((d) => depLine(r, d))}
      ${reviewBox(r, p, back, p.interdiffFile === undefined ? undefined : ctx.interdiff?.(p))}
    </td>
    <td>${item ? html`<span class="st ${stateClass(item.state)}">${item.state}</span>` : null}</td>
    <td class="hide-sm">${p.effort ?? ""}</td>
    <td class="num hide-sm">${rate === undefined ? "" : `${rate}/wk`}</td>
    ${reviewedColumn ? html`<td>${reviewers(r, p)}</td>` : null}
  </tr>`;
}

function bugLabel(p: PatchView): Html {
  if (p.bug !== null) {
    return html`<a class="bug" href="${bugUrl(p.bug)}" target="_blank" rel="noopener">Bug ${p.bug}</a>`;
  }
  if (p.bugDraft) {
    return html`<a class="bug tofile" href="${enterBugUrl(p.bugDraft)}" target="_blank" rel="noopener" title="Opens a prefilled enter_bug.cgi">Bug to file</a>`;
  }
  return html`<span class="bug none">Bug XXXXXXX</span>`;
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

function itemRow(r: RequestState, i: ItemView, ctx: RenderContext): Html {
  const running = [...i.jobs].reverse().map((j) => r.jobs[j]).find((j) => j && j.endedAt === undefined);
  const tests = i.group.tests;
  const name = tests.length === 1 ? tests[0] : i.folder;
  const closed = stateClass(i.state) === "closed";
  return html`<tr data-item="${i.id}">
    <td>${name} ${tests.length > 1 ? html`<span class="sub">(${tests.length} tests)</span>` : null}<div class="sub" title="${i.group.configs.join(", ")}">${i.group.message}</div></td>
    <td><span class="st ${stateClass(i.state)}">${i.state}${closed && i.detail ? `: ${i.detail}` : ""}</span></td>
    <td class="sub hide-sm">${
      running
        ? html`${running.model ?? running.kind} · ${elapsed(running.startedAt, ctx)}`
        : !closed && i.detail
          ? `“${i.detail}”`
          : ""
    }</td>
  </tr>`;
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
  return html`<h3>Recent jobs</h3><div class="scroll"><table><tbody>${jobs.map(
    (j) =>
      html`<tr${j.error ? html` title="${j.error}"` : null}><td>${j.name} ${j.item ? html`<span class="sub">${j.item}</span>` : null}</td><td class="sub">${j.kind}${j.model ? ` · ${j.model}` : ""}</td><td class="res ${
        j.endedAt === undefined ? "run" : j.exitCode === 0 ? "ok" : "bad"
      }">${j.endedAt === undefined ? html`running ${elapsed(j.startedAt, ctx)}` : `${formatDuration(j.durationMs ?? Date.parse(j.endedAt) - Date.parse(j.startedAt))}${j.exitCode ? `, exit ${j.exitCode}` : ""}`}</td><td class="num sub">${
        j.costUsd === undefined ? "" : formatCost(j.costUsd)
      }</td></tr>`,
  )}</tbody></table></div>`;
}
