import type { StreamStep, StreamSummary } from "../../agents/run.ts";
import { isPushJob } from "../../state/flags.ts";
import type { ItemView, JobView, RequestId, RequestState } from "../../types.ts";
import { html, type Html } from "../html.ts";
import { continueBox, stopButton } from "./actions.ts";
import { elapsed, formatCost, formatDuration, jobLabel, modelLabel, plural, requestUrl, stateClass, type RenderContext } from "./common.ts";
import { runningSentence, workLabel } from "./progress.ts";

export function jobUrl(request: RequestId, job: string, what: "activity" | "transcript" | "profile" | "log" | `mach-profile-${number}`): string {
  return `/api/requests/${encodeURIComponent(request)}/jobs/${encodeURIComponent(job)}/${what}`;
}

// One line per job: what it did, how long, what it cost. An agent's line opens on its conversation, which
// client.js reloads every few seconds while it runs and stays open.
export function jobLine(r: RequestState, j: JobView, ctx: RenderContext): Html {
  const running = j.endedAt === undefined;
  const cls = running ? "run" : j.exitCode === 0 ? "ok" : "bad";
  const time = running ? html`running ${elapsed(j.startedAt, ctx)}` : html`${formatDuration(j.durationMs ?? Date.parse(j.endedAt!) - Date.parse(j.startedAt))}${j.exitCode ? `, exit ${j.exitCode}` : ""}`;
  const what = j.name === "investigate-and-fix" ? runningSentence(j) : j.name === "recover" ? workLabel(j) : jobLabel(j.name);
  // A script or build opens its log; its mach builds and test runs, their profiles.
  const label = j.kind === "agent" ? html`${what}` : html`<a href="${jobUrl(r.id, j.job, "log")}" target="_blank" rel="noopener" title="Its output">${what}</a>`;
  const profiles = Array.from({ length: j.machProfiles ?? 0 }, (_, n) => {
    const url = `${ctx.baseUrl}${jobUrl(r.id, j.job, `mach-profile-${n + 1}`)}`;
    const name = `${j.kind === "build" ? "build profile" : "profile"}${j.machProfiles! > 1 ? ` ${n + 1}` : ""}`;
    return html` · <a href="${ctx.profilerOrigin}/from-url/${encodeURIComponent(url)}" target="_blank" rel="noopener" title="Its mach resource-usage profile, in the Firefox Profiler">${name}</a>`;
  });
  const line = html`<span class="res ${cls}">${label}</span> <span class="sub">${j.model ? `${modelLabel(j.model)} · ` : ""}${time}${j.costUsd === undefined ? "" : ` · ${formatCost(j.costUsd)}`}</span>${
      running && !isPushJob(j) ? html` ${stopButton(r.id, j.job, requestUrl(r.id))}` : null
    }${profiles}${j.outcome ? html`<span class="outcome clamp1" title="${j.outcome}">${j.outcome}</span>` : j.kind !== "agent" && j.error ? html`<span class="outcome clamp1" title="${j.error}">${j.error}</span>` : null}`;
  const title = j.error ? html` title="${j.error}"` : null;
  // The box to answer is outside the reloaded part, so what you type stays.
  return j.kind === "agent"
    ? html`<details class="job" data-fold="job-${j.job}" data-watch="${jobUrl(r.id, j.job, "activity")}"${running ? html` data-live` : null}><summary${title}>${line}</summary><div class="activity">Loading…</div>${
        talkable(r, j) ? html`<div class="talk">${continueBox(r.id, j.item!, requestUrl(r.id))}</div>` : null
      }</details>`
    : html`<div class="job"${title}>${line}</div>`;
}

// A group's jobs: the running ones, and failures nothing ran again after while the group is open; the rest on
// one line (agent runs, sessions, their cost by model in its tooltip) that opens on their list.
export function groupJobs(r: RequestState, i: ItemView, jobs: JobView[], ctx: RenderContext): Html | null {
  if (!jobs.length) {
    return null;
  }
  const later = (j: JobView) => i.jobs.slice(i.jobs.indexOf(j.job) + 1).some((x) => r.jobs[x].name === j.name);
  const shown = jobs.filter((j) => j.endedAt === undefined || (j.exitCode !== 0 && stateClass(i.state) !== "closed" && !later(j)));
  const ended = jobs.filter((j) => !shown.includes(j));
  // One line folded under one line saves nothing.
  if (ended.length < 2) {
    return html`<div class="jobs">${jobs.map((j) => jobLine(r, j, ctx))}</div>`;
  }
  const agents = ended.filter((j) => j.kind === "agent");
  const sessions = new Set(agents.map((j) => j.sessionId ?? j.job)).size;
  const byModel = new Map<string, number>();
  for (const j of ended) {
    if (j.costUsd !== undefined) {
      const m = j.model ? modelLabel(j.model) : "Other";
      byModel.set(m, (byModel.get(m) ?? 0) + j.costUsd);
    }
  }
  const cost = [...byModel.values()].reduce((a, b) => a + b, 0);
  const parts = [
    agents.length ? `${plural(agents.length, "agent run")}${sessions < agents.length ? ` in ${plural(sessions, "session")}` : ""}` : null,
    ended.length > agents.length ? plural(ended.length - agents.length, agents.length ? "other job" : "job") : null,
  ].filter((x) => x !== null);
  const summary = html`${parts.join(", ")}${byModel.size ? html` · <span class="cost" title="${[...byModel].sort((x, y) => y[1] - x[1]).map(([m, c]) => `${m} ${formatCost(c)}`).join(" · ")}">${formatCost(cost)}</span>` : null}`;
  return html`<div class="jobs">${shown.map((j) => jobLine(r, j, ctx))}<details class="fold ended" data-fold="jobs-${i.id}"><summary>${summary}</summary><div class="jobs">${ended.map((j) => jobLine(r, j, ctx))}</div></details></div>`;
}

// A message reaches an agent only through continue: to its group's latest author session, once it stopped.
function talkable(r: RequestState, j: JobView): boolean {
  if (j.item === undefined || !isAuthor(j)) {
    return false;
  }
  const authors = r.items[j.item].jobs.map((x) => r.jobs[x]).filter(isAuthor);
  const session = authors.filter((a) => a.purpose?.reason === undefined || a.purpose.reason === "initial" || a.purpose.reason === "start").at(-1);
  return j.sessionId !== undefined && j.sessionId === session?.sessionId && authors.at(-1)!.endedAt !== undefined;
}

// Jobs folded before JobView had a purpose: their name tells.
function isAuthor(j: JobView): boolean {
  return j.purpose ? j.purpose.what === "author" : j.name === "investigate-and-fix";
}

const SHOWN_STEPS = 20;

export interface Activity {
  steps: StreamStep[];
  summary: StreamSummary;
  transcript: boolean; // the session's transcript exists
  profileUrl?: string; // when claude-profiler is installed
}

// The last steps of an agent run from its out.log: what it's doing now, and where to read more.
export function renderActivity(request: RequestId, job: JobView, a: Activity | undefined, ctx: RenderContext): Html {
  const time =
    job.endedAt === undefined ? html`running for ${elapsed(job.startedAt, ctx)}` : html`ran ${formatDuration(job.durationMs ?? Date.parse(job.endedAt) - Date.parse(job.startedAt))}`;
  const cost = job.costUsd ?? a?.summary.costUsd;
  const head = html`<div class="sub">${time}${cost === undefined ? null : html` · ${formatCost(cost)}`}${a ? html` · ${a.summary.toolUses.count} tool calls` : null}${
    a?.transcript ? html` · <a href="${jobUrl(request, job.job, "transcript")}" target="_blank" rel="noopener">Transcript</a>` : null
  }${a?.profileUrl ? html` · <a href="${a.profileUrl}" target="_blank" rel="noopener">Profile</a>` : null}</div>`;
  if (!a) {
    return html`${head}<div class="sub">No output yet.</div>`;
  }
  const steps = a.steps.slice(-SHOWN_STEPS);
  return html`${head}<ol class="steps">${steps.map(
    (s) => html`<li${s.subagent ? html` class="subagent" title="in a subagent"` : null}><b>${s.tool}</b>${s.text ? html` <span class="mono">${s.text}</span>` : null}</li>`,
  )}</ol>${a.summary.lastAssistantText ? html`<div class="said-last">${a.summary.lastAssistantText}</div>` : null}`;
}
