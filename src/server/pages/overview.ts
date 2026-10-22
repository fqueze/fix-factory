import type { RequestState } from "../../types.ts";
import { html, type Html } from "../html.ts";
import { commandFields, formatDate, isDraft, isDropped, needsYou, plural, profileUrl, pushResultClass, pushStatus, pushUrl, requestCost, requestName, requestUrl, routeOutcome, sectionOf, shortName, type RenderContext } from "./common.ts";
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
  const jobs = requests.flatMap((r) => Object.values(r.jobs)).filter((j) => j.endedAt === undefined);
  const agents = jobs.filter((j) => j.kind === "agent").length;
  const builds = jobs.filter((j) => j.kind === "build").length;
  const progress = sumProgress(requests.filter((r) => sectionOf(r) !== "finished").map((r) => requestProgress(r, ctx)));
  return html`<div class="strip" id="strip">
    <span>agents <b>${agents}${ctx.maxAgents ? `/${ctx.maxAgents}` : ""}</b></span>
    <span>builds <b>${builds}${ctx.maxBuilds ? `/${ctx.maxBuilds}` : ""}</b></span>
    ${ctx.freeDiskGB === undefined ? null : html`<span class="${ctx.freeDiskGB < 100 ? "disk-low" : ""}" title="Free space for worktrees; none is created below 20 GB">disk <b>${diskSize(ctx.freeDiskGB)}</b> free</span>`}
    <span class="progress">${progressLine(progress)}</span>
  </div>`;
}

function diskSize(gb: number): string {
  return gb >= 1000 ? `${(gb / 1000).toFixed(1)} TB` : `${Math.floor(gb)} GB`;
}

// Everything under the header, also served alone so the client can refresh it
// when a request appears or moves between sections.
export function renderMain(requests: RequestState[], ctx: RenderContext): Html {
  const byUpdate = [...requests].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Requests that need you first, the rest by latest activity.
  const active = byUpdate.filter((r) => sectionOf(r) === "active").sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)));
  const queued = byUpdate.filter((r) => sectionOf(r) === "queued").reverse();
  // Finished requests open like the active ones; text that was forwarded or rephrased is one line.
  const finished = byUpdate.filter((r) => sectionOf(r) === "finished");
  return html`<form class="ask cmd" method="post" action="/api/commands">${commandFields([{ cmd: "tell-factory" }], "/")}<input type="text" name="text" required placeholder="Tell the factory… (e.g. “burn down dom/base/test”, or “Lando was down this morning, re-push what failed”)"><button class="btn">Send</button></form>

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
      html`<div class="row" data-request="${r.id}" data-section="finished"><span class="grow"><b>${requestName(r)}</b> <span class="sub">· ${routeOutcome(r)}</span></span><a class="btn small" href="${profileUrl(ctx, r.id)}" target="_blank" rel="noopener">Profile</a></div>`,
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
