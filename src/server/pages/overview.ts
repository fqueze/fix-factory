import { html, type Html } from "../html.ts";
import { commandFields, formatDate, plural, profileUrl, requestName, sectionOf, shortName, TREEHERDER, type RenderContext, type Request } from "./common.ts";
import { renderRequest } from "./request.ts";

const PHAB_SYMBOL = html`<svg style="display:none"><symbol id="phab" viewBox="0 0 16 16"><path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2.3" fill="currentColor"/></symbol></svg>`;

export function renderOverview(requests: Request[], ctx: RenderContext): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fix factory</title>
<link rel="stylesheet" href="/style.css">
<script src="/client.js" defer></script>
</head>
<body>
${PHAB_SYMBOL}
<header><div class="hwrap">
  <h1>🏭 Fix factory</h1>
  ${renderStrip(requests, ctx)}
  <div class="spacer"></div>
  ${newRequestForm()}
</div></header>
<main id="main">
${renderMain(requests, ctx)}
</main>
</body>
</html>
`.value;
}

export function renderStrip(requests: Request[], ctx: RenderContext): Html {
  const jobs = requests.flatMap((r) => Object.values(r.jobs)).filter((j) => j.endedAt === undefined);
  const agents = jobs.filter((j) => j.kind === "agent").length;
  const builds = jobs.filter((j) => j.kind === "build").length;
  const needs = requests.filter((r) => r.needsUser.length > 0).length;
  return html`<div class="strip" id="strip">
    <span>agents <b>${agents}${ctx.maxAgents ? `/${ctx.maxAgents}` : ""}</b></span>
    <span>builds <b>${builds}${ctx.maxBuilds ? `/${ctx.maxBuilds}` : ""}</b></span>
    <span><b>${needs}</b> ${needs === 1 ? "request needs" : "requests need"} you</span>
  </div>`;
}

function newRequestForm(): Html {
  return html`<details class="newreq"><summary class="btn primary">+ New request</summary>
    <form class="cmd" method="post" action="/api/commands" data-new-request>
      <input type="hidden" name="back" value="/">
      <select name="kind"><option value="burndown">Burn down a folder</option><option value="try-push">Fix the failures of a try push</option></select>
      <input type="text" name="folder" placeholder="Folder, e.g. toolkit/components/extensions/test/xpcshell">
      <input type="text" name="rev" placeholder="Try push revision">
      <textarea name="text" rows="3" placeholder="What you want, constraints, platforms…"></textarea>
      <div><button class="btn primary">Start</button></div>
    </form>
  </details>`;
}

// Everything under the header, also served alone so the client can refresh it
// when a request appears or moves between sections.
export function renderMain(requests: Request[], ctx: RenderContext): Html {
  const byUpdate = [...requests].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Requests that need you first, the rest by latest activity.
  const active = byUpdate.filter((r) => sectionOf(r) === "active").sort((a, b) => Number(b.needsUser.length > 0) - Number(a.needsUser.length > 0));
  const queued = byUpdate.filter((r) => sectionOf(r) === "queued").reverse();
  const finished = byUpdate.filter((r) => sectionOf(r) === "finished");
  return html`<form class="ask cmd" method="post" action="/api/commands">${commandFields([{ cmd: "tell-factory" }], "/")}<input type="text" name="text" required placeholder="Tell the factory… (e.g. “Lando was down this morning, re-push what failed”)"><button class="btn">Send</button></form>

  <h2>Active <span class="count">${active.length}</span></h2>
  <div id="section-active">${active.map((r) => renderRequest(r, ctx))}</div>

  ${queued.length ? html`<h2>Queued <span class="count">${queued.length}</span></h2>
  <div class="simple" id="section-queued">${queued.map(
    (r) =>
      html`<div class="row" data-request="${r.id}" data-section="queued"><span class="grow"><b>${requestName(r)}</b> <span class="sub">· waits for an agent slot</span></span><form class="inline cmd" method="post" action="/api/commands">${commandFields(
        [{ cmd: "start-now", request: r.id }],
        "/",
      )}<button class="btn small">Start now</button></form></div>`,
  )}</div>` : null}

  ${renderRecentPushes(requests)}

  ${finished.length ? html`<h2>Finished</h2>
  <details class="archive"${finished.some((r) => r.id === ctx.open) ? html` open` : null}>
    <summary>▸ ${plural(finished.length, "request")}</summary>
    <div class="simple" id="section-finished">${finished.map(
      (r) =>
        html`<div class="row" data-request="${r.id}" data-section="finished"><span class="grow"><b>${requestName(r)}</b> <span class="sub">· ${plural(Object.keys(r.patches).length, "patch", "patches")}, done ${formatDate(r.updatedAt)}</span></span><a class="btn small" href="${profileUrl(ctx, r.id)}" target="_blank" rel="noopener">Profile</a></div>`,
    )}</div>
  </details>` : null}`;
}

export function renderRecentPushes(requests: Request[]): Html | null {
  const pushes = [...requests]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .flatMap((r) =>
      Object.values(r.pushes)
        .filter((p) => p.rev)
        .reverse()
        .map((p) => ({ r, p })),
    )
    .slice(0, 10);
  if (!pushes.length) {
    return null;
  }
  return html`<h2>Recent try pushes</h2>
  <div class="simple scroll" id="recent-pushes"><table><tbody>${pushes.map(({ r, p }) => {
    const res = p.result ? (p.result === "green" ? "ok" : "bad") : "run";
    const text = p.result ? (p.result === "green" ? "green" : p.summary || "failures") : p.progress ? `${p.progress.done}/${p.progress.total}, ${plural(p.progress.failures, "failure")}` : "pushed";
    return html`<tr><td class="mono"><a href="${p.url ?? TREEHERDER + p.rev}" target="_blank" rel="noopener">${p.rev!.slice(0, 12)}</a></td><td class="hide-sm"><a href="/requests/${encodeURIComponent(r.id)}">${shortName(r)}</a></td><td>${p.purpose}</td><td class="res ${res}">${text}</td></tr>`;
  })}</tbody></table></div>`;
}
