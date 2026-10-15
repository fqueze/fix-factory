import type { StreamStep, StreamSummary } from "../../agents/run.ts";
import type { JobView, RequestId } from "../../types.ts";
import { html, type Html } from "../html.ts";
import { elapsed, formatCost, formatDuration, type RenderContext } from "./common.ts";

const SHOWN_STEPS = 20;

export function jobUrl(request: RequestId, job: string, what: "activity" | "transcript" | "profile"): string {
  return `/api/requests/${encodeURIComponent(request)}/jobs/${encodeURIComponent(job)}/${what}`;
}

// Opening it loads the agent's activity, and client.js reloads it every few seconds while it stays open.
export function watchDetails(request: RequestId, job: string): Html {
  return html`<details class="watch" data-fold="watch-${job}" data-watch="${jobUrl(request, job, "activity")}"><summary class="btn small">Watch</summary><div class="activity sub">Loading…</div></details>`;
}

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
  const steps = a.steps.filter((s) => s.kind === "tool").slice(-SHOWN_STEPS);
  return html`${head}<ol class="steps">${steps.map(
    (s) => html`<li${s.subagent ? html` class="subagent" title="in a subagent"` : null}><b>${s.tool}</b>${s.text ? html` <span class="mono">${s.text}</span>` : null}</li>`,
  )}</ol>${a.summary.lastAssistantText ? html`<div class="said-last">${a.summary.lastAssistantText}</div>` : null}`;
}
