import { toolCallText, type StreamSummary } from "../../agents/run.ts";
import { md } from "./md.ts";
import { isPushJob } from "../../state/flags.ts";
import type { ItemView, JobView, RequestId, RequestState } from "../../types.ts";
import { html, type Html } from "../html.ts";
import { continueBox, stopButton } from "./actions.ts";
import { elapsed, formatCost, formatDuration, jobLabel, modelLabel, plural, profileUrl, requestUrl, stateClass, type RenderContext } from "./common.ts";
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
  const summary = html`${parts.join(", ")}${byModel.size ? html` · <a class="cost" href="${profileUrl(ctx, r.id, i.id)}" target="_blank" rel="noopener" title="${[...byModel].sort((x, y) => y[1] - x[1]).map(([m, c]) => `${m} ${formatCost(c)}`).join(" · ")} · its profile">${formatCost(cost)}</a>` : null}`;
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

// An agent's run as a conversation, from its out.log (claude -p stream-json): what it was told, what it said,
// its tool calls in order, and its report.
export type Turn =
  | { kind: "user"; text: string; synthetic?: boolean } // synthetic: a skill's instructions, loaded by a tool call
  | { kind: "said"; text: string }
  | { kind: "call"; id: string; tool: string; input: Record<string, unknown>; output?: string; error?: boolean; subagent?: boolean };

export interface Activity {
  prompt?: string; // its prompt.md: the first prompt, or the message a resumed session got
  turns: Turn[];
  summary: StreamSummary;
  transcript: boolean; // the session's transcript exists
  profileUrl?: string; // when claude-profiler is installed
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export function conversationOf(log: string): Turn[] {
  const turns: Turn[] = [];
  const calls = new Map<string, Extract<Turn, { kind: "call" }>>();
  for (const line of log.split("\n")) {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // blank, or still being written
    }
    if ((msg?.type !== "assistant" && msg?.type !== "user") || !Array.isArray(msg.message?.content)) {
      continue;
    }
    // A subagent's own conversation runs beside the main one: only its tool calls are shown.
    const subagent = typeof msg.parent_tool_use_id === "string";
    for (const b of msg.message.content as Block[]) {
      if (b.type === "tool_use" && b.id && b.name) {
        const call = { kind: "call" as const, id: b.id, tool: b.name, input: b.input ?? {}, ...(subagent ? { subagent } : {}) };
        calls.set(b.id, call);
        turns.push(call);
      } else if (b.type === "tool_result" && b.tool_use_id && calls.has(b.tool_use_id)) {
        const call = calls.get(b.tool_use_id)!;
        call.output = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map((c) => c.text ?? `[${c.type}]`).join("\n") : "";
        call.error = b.is_error === true;
      } else if (b.type === "text" && b.text?.trim() && !subagent) {
        turns.push(msg.type === "assistant" ? { kind: "said", text: b.text } : { kind: "user", text: b.text, ...(msg.isSynthetic ? { synthetic: true } : {}) });
      }
    }
  }
  return turns;
}

const SHOWN_CALLS = 3; // of a long run of tool calls, the last ones; the earlier ones folded
const MAX_TEXT = 3000; // of a tool call's input or output

// Where to read more, then the conversation; the time and cost are on its line already.
export function renderActivity(request: RequestId, job: JobView, a: Activity | undefined, ctx: RenderContext): Html {
  const links = [
    a?.transcript ? html`<a href="${jobUrl(request, job.job, "transcript")}" target="_blank" rel="noopener">Transcript</a>` : null,
    a?.profileUrl ? html`<a href="${a.profileUrl}" target="_blank" rel="noopener">Profile</a>` : null,
  ].filter((x) => x !== null);
  const head = links.length ? html`<div class="sub links">${links.map((l, n) => html`${n ? " · " : ""}${l}`)}</div>` : null;
  if (!a) {
    return html`${head}<div class="sub">No output yet.</div>`;
  }
  const turns = a.turns.filter((t) => t.kind !== "call" || t.tool !== "StructuredOutput");
  // Runs of tool calls between messages.
  const groups: Turn[][] = [];
  for (const t of turns) {
    const last = groups.at(-1);
    if (t.kind === "call" && last?.[0].kind === "call") {
      last.push(t);
    } else {
      groups.push([t]);
    }
  }
  const s = a.summary;
  const end =
    s.report !== undefined
      ? html`<div class="turn agent report">${reportHtml(s.report)}</div>`
      : s.isError && s.resultText
        ? html`<div class="turn agent bad">${md(s.resultText)}</div>`
        : job.endedAt === undefined
          ? html`<div class="sub">working ${elapsed(job.startedAt, ctx)}…</div>`
          : null;
  return html`${head}<div class="convo">${a.prompt ? html`<div class="turn user prompt" data-expand title="Click to expand">${md(a.prompt)}</div>` : null}${groups.map((g, n) =>
    g[0].kind === "call" ? callRun(g as Extract<Turn, { kind: "call" }>[]) : turnHtml(g[0], n),
  )}${end}</div>`;
}

function turnHtml(t: Exclude<Turn, { kind: "call" }>, n: number): Html {
  if (t.kind === "said") {
    return html`<div class="turn agent">${md(t.text)}</div>`;
  }
  return t.synthetic
    ? html`<div class="calls"><details class="call" data-more="loaded-${n}"><summary>${t.text.startsWith("Base directory for this skill") ? "the skill's instructions" : "instructions"}</summary><pre class="out">${clip(t.text)}</pre></details></div>`
    : html`<div class="turn user">${md(t.text)}</div>`;
}

function callRun(calls: Extract<Turn, { kind: "call" }>[]): Html {
  const folded = calls.length > SHOWN_CALLS + 1 ? calls.slice(0, -SHOWN_CALLS) : [];
  return html`<div class="calls">${
    folded.length ? html`<details class="more" data-more="calls-${calls[0].id}"><summary>${plural(folded.length, "earlier tool call")}</summary>${folded.map(callHtml)}</details>` : null
  }${calls.slice(folded.length).map(callHtml)}</div>`;
}

function callHtml(c: Extract<Turn, { kind: "call" }>): Html {
  // Tools it has no short form for (Skill, ToolSearch…): their first text argument.
  const text = withoutCd(toolCallText(c.tool, c.input) || (Object.values(c.input).find((x) => typeof x === "string") as string | undefined) || "");
  const input = c.tool === "Bash" && typeof c.input.command === "string" ? c.input.command : JSON.stringify(c.input, null, 2);
  return html`<details class="call${c.subagent ? " subagent" : ""}${c.error ? " bad" : ""}" data-more="call-${c.id}"${c.subagent ? html` title="in a subagent"` : null}><summary><b>${c.tool}</b>${
    text ? html` <span class="mono">${text}</span>` : null
  }${c.output === undefined ? html` <span class="sub">…</span>` : null}</summary><pre class="in">${clip(input)}</pre>${c.output ? html`<pre class="out">${clip(c.output)}</pre>` : null}</details>`;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… ${text.length - MAX_TEXT} more characters` : text;
}

// A report in words: its fields as headings, lists as lists; empty fields left out, the agent's
// feedback on the factory last.
function reportHtml(v: unknown): Html | null {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) {
    return null;
  }
  if (Array.isArray(v)) {
    return html`<ul>${v.map((x) => html`<li>${x !== null && typeof x === "object" && !Array.isArray(x) ? inline(x as Record<string, unknown>) : reportHtml(x)}</li>`)}</ul>`;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => reportHtml(x) !== null);
    const sorted = [...entries.filter(([k]) => k !== "feedback"), ...entries.filter(([k]) => k === "feedback")];
    return html`<dl>${sorted.map(([k, x]) => html`<dt>${inWords(k)}</dt><dd>${reportHtml(x)}</dd>`)}</dl>`;
  }
  return typeof v === "string" ? html`<div class="rtext">${md(v)}</div>` : html`<span class="rtext">${String(v)}</span>`;
}

// A list item's short fields on one line ("must-fix · foo.js · 12"), its long text after them.
function inline(o: Record<string, unknown>): Html {
  const short = Object.entries(o).filter(([, x]) => (typeof x === "string" && x.length <= 60) || typeof x === "number" || typeof x === "boolean");
  const rest = Object.entries(o).filter(([k]) => !short.some(([s]) => s === k));
  return html`${short.length ? html`<span class="sub">${short.map(([, x]) => String(x)).join(" · ")}</span> ` : null}${rest.map(([k, x]) =>
    typeof x === "string" ? html`<div class="rtext">${md(x)}</div>` : reportHtml(x) === null ? null : html`<div><b>${inWords(k)}</b> ${reportHtml(x)}</div>`,
  )}`;
}

function inWords(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Agents start most commands with "cd <their worktree>;", the same on every line.
function withoutCd(command: string): string {
  return command.replace(/^cd \S+\s*(?:&&|;)\s*/, "");
}
