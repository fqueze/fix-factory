import type { JobView, RequestState } from "../../types.ts";
import { html, type Html } from "../html.ts";
import { commandFields, elapsed, formatCost, formatDate, jobLabel, isDraft, isDropped, plural, profileUrl, pushResultClass, pushStatus, pushUrl, requestCost, requestName, requestUrl, routeOutcome, sectionOf, shortName, type RenderContext } from "./common.ts";
import { progressLine, requestProgress, sumProgress } from "./progress.ts";
import { renderRequest } from "./request.ts";

const PHAB_SYMBOL = html`<svg style="display:none"><symbol id="phab" viewBox="0 0 16 16"><path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2.3" fill="currentColor"/></symbol></svg>`;

export function renderOverview(requests: RequestState[], ctx: RenderContext): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fix factory</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏭</text></svg>">
<link rel="stylesheet" href="/style.css">
<script src="/client.js" defer></script>
</head>
<body>
${PHAB_SYMBOL}
<header><div class="hwrap">
  <h1>🏭 Fix factory</h1>
  ${renderStrip(requests, ctx)}
</div></header>
<main id="main">
${renderMain(requests, ctx)}
</main>
</body>
</html>
`.value;
}

export function renderStrip(requests: RequestState[], ctx: RenderContext): Html {
  const jobs = requests.flatMap((r) => Object.values(r.jobs).filter((j) => j.endedAt === undefined).map((j) => ({ r, j })));
  const agents = jobs.filter(({ j }) => j.kind === "agent");
  const builds = jobs.filter(({ j }) => j.kind === "build");
  const progress = sumProgress(requests.filter((r) => sectionOf(r) !== "finished").map((r) => requestProgress(r, ctx)));
  // What landed counts whole: finished requests' too (the rest of theirs isn't work left).
  progress.landed += requests.filter((r) => sectionOf(r) === "finished").reduce((n, r) => n + requestProgress(r, ctx).landed, 0);
  return html`<div class="strip" id="strip">
    ${running("agents", agents, ctx.maxAgents, ctx)}
    ${running("builds", builds, ctx.maxBuilds, ctx)}
    ${ctx.freeDiskGB === undefined ? null : html`<span class="${ctx.freeDiskGB < 100 ? "disk-low" : ""}" title="Free space for worktrees; none is created below 20 GB">disk <b>${diskSize(ctx.freeDiskGB)}</b> free</span>`}
    <a href="/feedback" target="_blank">agents' feedback</a>
    <span class="progress">${progressLine(progress)}</span>
  </div>`;
}

// The count, and on hover what runs: each job with its group and request, linked to its row.
function running(what: string, jobs: { r: RequestState; j: JobView }[], max: number | undefined, ctx: RenderContext): Html {
  const count = html`${what} <b>${jobs.length}${max ? `/${max}` : ""}</b>`;
  if (jobs.length === 0) return html`<span>${count}</span>`;
  const line = ({ r, j }: { r: RequestState; j: JobView }) => {
    const item = j.item ? r.items[j.item] : undefined;
    const patch = j.purpose?.patch ?? Object.values(r.patches).find((p) => p.item === j.item)?.id;
    const target = patch ? `patch-${patch}` : item ? `item-${item.id}` : `req-${r.id}`;
    const subject = item ? (item.group.tests[0]?.split("/").pop() ?? item.id) : requestName(r);
    return html`<a href="#${target}"><b>${jobLabel(j.name)}</b> ${subject}${item ? html` <span class="sub">· ${requestName(r)}</span>` : null} <span class="sub">· ${elapsed(j.startedAt, ctx)}</span></a>`;
  };
  return html`<span class="running" tabindex="0">${count}<span class="running-list">${jobs.sort((a, b) => a.j.startedAt.localeCompare(b.j.startedAt)).map(line)}</span></span>`;
}

function diskSize(gb: number): string {
  return gb >= 1000 ? `${(gb / 1000).toFixed(1)} TB` : `${Math.floor(gb)} GB`;
}

// Everything under the header, also served alone so the client can refresh it
// when a request appears or moves between sections.
export function renderMain(requests: RequestState[], ctx: RenderContext): Html {
  // A stable order: by latest activity, or with those needing you first, requests kept moving with every event.
  // Active ones newest first, queued ones in the order they start, finished ones latest finished first.
  const byCreation = [...requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = byCreation.filter((r) => sectionOf(r) === "active");
  const queued = byCreation.filter((r) => sectionOf(r) === "queued").reverse();
  // Finished requests open like the active ones; text that was forwarded or rephrased is one line.
  const finished = byCreation.filter((r) => sectionOf(r) === "finished").sort((a, b) => (b.finishedAt ?? b.updatedAt).localeCompare(a.finishedAt ?? a.updatedAt));
  return html`<form class="ask cmd joined" method="post" action="/api/commands">${commandFields([{ cmd: "tell-factory" }], "/")}<input type="text" name="text" required placeholder="Tell the factory… (e.g. “burn down dom/base/test”, or “Lando was down this morning, re-push what failed”)"><button class="btn">Send</button></form>

  <h2>Active <span class="count">${active.length}</span></h2>
  <div id="section-active">${active.map((r) => renderRequest(r, ctx))}</div>

  ${queued.length ? html`<h2>Queued <span class="count">${queued.length}</span></h2>
  <div class="simple" id="section-queued">${queued.map(
    (r) =>
      html`<div class="row" data-request="${r.id}" data-section="queued"><span class="grow"><b>${requestName(r)}</b> <span class="sub">· ${r.kind === "unrouted" ? "not routed yet, " : ""}waits for an agent slot</span></span><form class="inline cmd" method="post" action="/api/commands">${commandFields(
        [{ cmd: "start-now", request: r.id }],
        "/",
      )}<button class="btn small">Start now</button></form></div>`,
  )}</div>` : null}

  ${renderRecentPushes(requests)}

  ${finished.length ? html`<h2>Finished <span class="count">${finished.length}</span></h2>
  <div id="section-finished">${finished.filter((r) => r.kind !== "unrouted").map((r) => renderRequest(r, ctx, ctx.open?.includes(r.id)))}</div>
  ${finished.some((r) => r.kind === "unrouted") ? html`<div class="simple">${finished.filter((r) => r.kind === "unrouted").map(
    (r) =>
      html`<div class="row" data-request="${r.id}" data-section="finished"><span class="grow"><b>${requestName(r)}</b> <span class="sub">· ${routeOutcome(r)}</span></span>${requestCost(r) > 0 ? html`<a class="cost" href="${profileUrl(ctx, r.id)}" target="_blank" rel="noopener" title="What its agents cost: its profile">${formatCost(requestCost(r))}</a>` : null}</div>`,
  )}</div>` : null}` : null}`;
}

// The pushes still running, one line each: what's on try right now, and which request it's for.
export function renderRecentPushes(requests: RequestState[]): Html | null {
  const pushes = requests.flatMap((r) =>
    Object.values(r.pushes)
      .filter((p) => p.rev && p.result === undefined)
      .reverse()
      .map((p) => ({ r, p })),
  );
  if (!pushes.length) {
    return null;
  }
  return html`<h2>On try now</h2>
  <div class="simple" id="recent-pushes">${pushes.map(
    ({ r, p }) =>
      html`<div class="row tryrow"><a class="mono" href="${pushUrl(p)}" target="_blank" rel="noopener">${p.rev!.slice(0, 12)}</a><span class="res ${pushResultClass(p)}">${pushStatus(p)}</span><a class="grow ellipsis" href="${requestUrl(r.id)}#push-${p.id}" title="${p.purpose}">${requestName(r).replace(/^Flakiness burndown: /, "")}: ${p.purpose}</a></div>`,
  )}</div>`;
}
